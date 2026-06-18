/**
 * Per-messageId reassembly buffer for the chunked webhook.relay protocol.
 *
 * Platform splits the inbound webhook body into N WS frames so a 25 MiB body
 * can interleave with other concurrent traffic. The orchestrator must:
 * - Allocate a buffer on `webhook.relay.start` keyed by `messageId`.
 * - Append each `webhook.relay.chunk` in strict ascending sequence order.
 * - Enforce the 25 MiB hard ceiling (defensively; Platform also caps).
 * - On the chunk where `final=true`, return the assembled body + metadata so
 *   the WS handler can run verify+process and emit the ack.
 * - Garbage-collect buffers Platform abandoned mid-stream (e.g. the originating
 *   Platform process crashed between chunks) via a per-buffer TTL.
 *
 * Concurrency: a single orchestrator may be receiving many concurrent inbound
 * webhooks; the registry is a Map keyed by messageId so streams don't collide.
 *
 * Errors are NEVER thrown — every malformed input produces a typed `ChunkError`
 * with a non-secret-bearing diagnostic the WS handler maps to a
 * `rejected_misconfigured` ack. This keeps the WS handler inside its 5 s budget
 * and prevents a malicious sender from killing the orch process via a bad frame.
 */

import { createLogger } from '@kici-dev/shared';
import { WEBHOOK_RELAY_MAX_BODY_BYTES } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'relay-buffer' });

/**
 * Default per-buffer TTL. Set generously so a slow legitimate sender finishes
 * but tight enough that abandoned buffers don't pile up. The 5 s ACK budget on
 * the Platform side already bounds how long any single relay can take; this
 * TTL is the orch-side safety net for buffers Platform never flushes.
 */
const DEFAULT_BUFFER_TTL_MS = 30_000;

/** Metadata captured on the start frame and kept for the lifetime of the stream. */
export interface RelayStartMeta {
  routingKey: string;
  deliveryId: string;
  event: string;
  action: string | null | undefined;
  signatureHeaderName: string | null | undefined;
  signatureHeader: string | null | undefined;
  clientIp: string | null | undefined;
  headers: Record<string, string>;
  totalSize: number;
  chunkCount: number;
  requestId?: string;
}

/** Per-stream state kept while chunks are arriving. */
interface BufferEntry {
  meta: RelayStartMeta;
  /** Assembled chunks indexed by sequence (sparse only briefly during arrival). */
  chunks: Buffer[];
  /** Sum of byte lengths of chunks already received (defensive 25 MiB ceiling). */
  receivedBytes: number;
  /** The sequence number we expect on the NEXT chunk frame. */
  expectedSequence: number;
  /** Set once `final=true` arrives. The buffer is then drained on completion. */
  finalReceived: boolean;
  /** TTL timer; cleared on completion or explicit drop. */
  ttl: ReturnType<typeof setTimeout>;
}

/** Outcome of a chunk apply: either still waiting, or completed with a ready body. */
export type ChunkApplyResult =
  | { status: 'pending' }
  | { status: 'completed'; meta: RelayStartMeta; body: Buffer }
  | { status: 'error'; reason: string };

/** Outcome of a start: success or rejection (e.g., duplicate messageId). */
export type StartResult = { status: 'started' } | { status: 'error'; reason: string };

/**
 * Per-messageId reassembly registry.
 *
 * Single instance per orchestrator process. Concurrent inbound webhooks share
 * the same registry but operate on separate Map entries keyed by messageId.
 */
export class RelayBufferRegistry {
  private readonly buffers = new Map<string, BufferEntry>();
  private readonly bufferTtlMs: number;

  constructor(options: { bufferTtlMs?: number } = {}) {
    this.bufferTtlMs = options.bufferTtlMs ?? DEFAULT_BUFFER_TTL_MS;
  }

  /** Number of in-flight reassembly buffers. Useful for metrics + tests. */
  get size(): number {
    return this.buffers.size;
  }

  /**
   * Begin a new reassembly stream. Allocates an entry keyed by `meta.messageId`
   * (passed through the meta object's caller — actually keyed externally below).
   *
   * Returns an error if `messageId` is already in flight (Platform sent two
   * `start` frames with the same id, indicates a sender bug or abuse).
   */
  start(messageId: string, meta: RelayStartMeta): StartResult {
    if (this.buffers.has(messageId)) {
      return {
        status: 'error',
        reason: `duplicate webhook.relay.start for messageId ${messageId}`,
      };
    }
    if (meta.totalSize > WEBHOOK_RELAY_MAX_BODY_BYTES) {
      return {
        status: 'error',
        reason: `totalSize ${meta.totalSize} exceeds max ${WEBHOOK_RELAY_MAX_BODY_BYTES}`,
      };
    }
    if (meta.chunkCount < 1) {
      return { status: 'error', reason: `chunkCount must be >= 1, got ${meta.chunkCount}` };
    }

    const ttl = setTimeout(() => {
      this.buffers.delete(messageId);
      logger.warn('Reassembly buffer TTL expired before final chunk', {
        messageId,
        deliveryId: meta.deliveryId,
        receivedChunks: this.buffers.get(messageId)?.expectedSequence ?? 0,
      });
    }, this.bufferTtlMs);

    this.buffers.set(messageId, {
      meta,
      chunks: new Array<Buffer>(meta.chunkCount),
      receivedBytes: 0,
      expectedSequence: 0,
      finalReceived: false,
      ttl,
    });

    return { status: 'started' };
  }

  /**
   * Apply one chunk. Returns `pending` if more chunks expected, `completed`
   * with the assembled body when the final chunk closes the stream, or `error`
   * for any malformed-stream condition.
   *
   * Stream errors drop the buffer — the caller MUST ack `rejected_misconfigured`
   * and stop expecting further chunks for that messageId.
   */
  chunk(messageId: string, sequence: number, dataBase64: string, final: boolean): ChunkApplyResult {
    const entry = this.buffers.get(messageId);
    if (!entry) {
      return {
        status: 'error',
        reason: `no in-flight buffer for messageId ${messageId} (dropped or not started)`,
      };
    }

    if (sequence !== entry.expectedSequence) {
      this.drop(messageId);
      return {
        status: 'error',
        reason: `out-of-order chunk: expected sequence ${entry.expectedSequence}, got ${sequence}`,
      };
    }

    if (sequence >= entry.meta.chunkCount) {
      this.drop(messageId);
      return {
        status: 'error',
        reason: `sequence ${sequence} >= declared chunkCount ${entry.meta.chunkCount}`,
      };
    }

    let chunk: Buffer;
    try {
      chunk = Buffer.from(dataBase64, 'base64');
    } catch (err) {
      this.drop(messageId);
      return {
        status: 'error',
        reason: `base64 decode failed at sequence ${sequence}: ${(err as Error).message}`,
      };
    }

    const newReceived = entry.receivedBytes + chunk.length;
    if (newReceived > WEBHOOK_RELAY_MAX_BODY_BYTES) {
      this.drop(messageId);
      return {
        status: 'error',
        reason: `cumulative body size ${newReceived} exceeds max ${WEBHOOK_RELAY_MAX_BODY_BYTES}`,
      };
    }
    if (newReceived > entry.meta.totalSize) {
      this.drop(messageId);
      return {
        status: 'error',
        reason: `cumulative body size ${newReceived} exceeds declared totalSize ${entry.meta.totalSize}`,
      };
    }

    entry.chunks[sequence] = chunk;
    entry.receivedBytes = newReceived;
    entry.expectedSequence = sequence + 1;
    if (final) {
      entry.finalReceived = true;
    }

    // Completion conditions: `final=true` AND all expected chunks present.
    if (entry.finalReceived) {
      // The expected chunkCount may exceed sequence+1 if the sender lied about
      // chunkCount and finalized early. Treat that as misconfigured.
      if (entry.expectedSequence !== entry.meta.chunkCount) {
        this.drop(messageId);
        return {
          status: 'error',
          reason: `final flag at sequence ${sequence} but only ${entry.expectedSequence}/${entry.meta.chunkCount} chunks received`,
        };
      }
      if (entry.receivedBytes !== entry.meta.totalSize) {
        this.drop(messageId);
        return {
          status: 'error',
          reason: `assembled bytes ${entry.receivedBytes} != declared totalSize ${entry.meta.totalSize}`,
        };
      }
      const meta = entry.meta;
      const body = Buffer.concat(entry.chunks, entry.receivedBytes);
      this.drop(messageId);
      return { status: 'completed', meta, body };
    }

    return { status: 'pending' };
  }

  /**
   * Drop an in-flight buffer (TTL fired, stream errored, or assembly completed).
   * Idempotent: dropping a missing messageId is a no-op.
   */
  drop(messageId: string): void {
    const entry = this.buffers.get(messageId);
    if (!entry) return;
    clearTimeout(entry.ttl);
    this.buffers.delete(messageId);
  }

  /**
   * Drop every in-flight buffer. Used during graceful shutdown so abandoned
   * streams don't keep timers alive past process exit.
   */
  clear(): void {
    for (const [, entry] of this.buffers) {
      clearTimeout(entry.ttl);
    }
    this.buffers.clear();
  }
}
