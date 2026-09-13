/**
 * Channel-agnostic chunked transfer for fleet bundle ZIPs.
 *
 * The WS frame cap (WS_MAX_PAYLOAD_BYTES = 25 MiB) forbids shipping a whole
 * bundle in one frame, so a bundle Buffer is split into ordered base64 frames
 * (~85 KiB raw each, matching the webhook-relay frame size) and reassembled by
 * the receiver. Used on both the orchestrator-agent and peer channels.
 */

/** Raw bytes per chunk before base64 (matches webhook-relay's ~85 KiB frames). */
export const FLEET_CHUNK_BYTES = 85 * 1024;

export interface BundleChunkFrame {
  seq: number;
  dataB64: string;
  isLast: boolean;
}

/** Split a Buffer into ordered base64 frames. An empty buffer yields one final frame. */
export function chunkBuffer(
  buf: Buffer,
  chunkBytes: number = FLEET_CHUNK_BYTES,
): BundleChunkFrame[] {
  const frames: BundleChunkFrame[] = [];
  if (buf.length === 0) return [{ seq: 0, dataB64: '', isLast: true }];
  for (let offset = 0, seq = 0; offset < buf.length; offset += chunkBytes, seq++) {
    const slice = buf.subarray(offset, Math.min(offset + chunkBytes, buf.length));
    frames.push({
      seq,
      dataB64: slice.toString('base64'),
      isLast: offset + chunkBytes >= buf.length,
    });
  }
  return frames;
}

interface ChunkRequestPending {
  asm: BundleChunkAssembler;
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Correlation core for any "send a request, await a chunked response" channel.
 *
 * Key-agnostic so both the orchestrator-agent channel (keyed by requestId) and
 * the peer channel (keyed by messageId) share one implementation. Pending
 * requests reject on timeout, on an error frame, or on disconnect. No
 * orchestrator-initiated request/response primitive existed before fleet
 * collection; this is it.
 */
export class ChunkRequestWaiter {
  private pending = new Map<string, ChunkRequestPending>();

  /** Register a pending request `id` that rejects after `timeoutMs`. */
  add(id: string, timeoutMs: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`chunk request ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { asm: new BundleChunkAssembler(), resolve, reject, timer });
    });
  }

  /** Accumulate a chunk; resolves the pending request on the final frame. */
  onChunk(id: string, seq: number, dataB64: string, isLast: boolean): void {
    const p = this.pending.get(id);
    if (!p) return;
    try {
      const done = p.asm.accept(seq, dataB64, isLast);
      if (done) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.resolve(done);
      }
    } catch (err) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Reject the pending request `id` with `message`. */
  onError(id: string, message: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.reject(new Error(message));
  }

  /** Reject every pending request — used when the underlying connection drops. */
  rejectAll(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

/** Reassembles ordered frames into a Buffer. Throws on gaps/reordering. */
export class BundleChunkAssembler {
  private parts: Buffer[] = [];
  private next = 0;
  private done = false;

  /** Returns the assembled Buffer on the final frame, otherwise undefined. */
  accept(seq: number, dataB64: string, isLast: boolean): Buffer | undefined {
    if (this.done) throw new Error('bundle chunk received after final frame');
    if (seq !== this.next) {
      throw new Error(`out-of-order bundle chunk: expected ${this.next}, got ${seq}`);
    }
    this.next++;
    this.parts.push(Buffer.from(dataB64, 'base64'));
    if (isLast) {
      this.done = true;
      return Buffer.concat(this.parts);
    }
    return undefined;
  }
}
