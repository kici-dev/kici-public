/**
 * S3-backed log storage.
 *
 * Stores execution logs in S3. Retention is bounded by the orchestrator cleanup
 * sweep, which bulk-deletes objects older than `KICI_STEP_LOG_TTL_DAYS` (default
 * 90; 0 disables the sweep for operators running their own bucket lifecycle).
 *
 * Two write verbs with different durability contracts:
 *
 * - append() is an immediately-durable read-modify-write: GetObject the whole
 *   object, concatenate, PutObject it back. Correct for single-shot writers
 *   (webhook delivery payloads, rerun payloads, orchestration logs) that write
 *   once and read back without any finalize — N=1 means no amplification and no
 *   race. Its content is a plain single object at objectKey(path).
 * - appendStreaming() is the high-frequency step-log verb. S3 has no native
 *   append primitive, so it buffers chunks per step key in memory and seals an
 *   immutable `{objectKey(path)}/seg-NNNNNN` object (one PutObject, unique key)
 *   once the buffer reaches segmentFlushBytes OR its oldest byte reaches
 *   segmentFlushMs. Each byte is written exactly once (no O(N^2) amplification)
 *   and the unique seal key means concurrent appends to the same step can never
 *   overwrite one another. Durability of the final tail is guaranteed by
 *   finalize(path) at run completion.
 *
 * - finalize() seals the remaining tail buffer for a step key.
 * - read() lists sealed segments (plus any legacy/single object written by
 *   append()) and streams them via the byte-offset cursor.
 * - exists()/list() are segment-aware: `exists` is true when a single object or
 *   any segment is present; `list` collapses segment keys to their logical step
 *   path.
 *
 * All appendStreaming/finalize operations for one step key run through a
 * sequential execution chain so the in-memory buffer and seq counter are the
 * authoritative single writer even when the caller fires appends without
 * awaiting.
 *
 * Uses AWS SDK v3 modular imports -- only loaded when S3 storage is configured.
 */

import {
  type S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { assertSafeLogPath } from './log-storage.js';
import type { LogReadOptions, LogReadResult, LogStorage } from './log-storage.js';
import { createS3Client } from '@kici-dev/shared';

interface S3LogStorageOptions {
  bucket: string;
  prefix: string;
  region?: string;
  /** Custom endpoint URL for S3-compatible services (e.g., SeaweedFS, LocalStack) */
  endpoint?: string;
  /** Use path-style access instead of virtual-hosted-style (required for most S3-compatible services) */
  forcePathStyle?: boolean;
  /** Seal a step-log segment once the in-memory buffer reaches this many bytes. */
  segmentFlushBytes: number;
  /** Seal a step-log segment once the oldest buffered byte reaches this age (ms). */
  segmentFlushMs: number;
}

/** In-memory tail buffer for a single step key (appendStreaming path). */
interface SegmentBuffer {
  chunks: Buffer[];
  bytes: number;
  /** Epoch ms of the oldest unsealed byte (set on first buffered byte). */
  since: number;
  /** Next segment sequence number to seal. */
  seq: number;
  /** True once `seq` has been initialised from existing segments. */
  seqInit: boolean;
}

/** A sealed segment (or legacy/single object) that read()/exists() reason over. */
interface Segment {
  key: string;
  size: number;
}

/** An ordered byte range to fetch from one object during a read. */
interface RangeRead {
  key: string;
  /** Inclusive start byte offset within the object. */
  start: number;
  /** Inclusive end byte offset within the object. */
  end: number;
}

export class S3LogStorage implements LogStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly segmentFlushBytes: number;
  private readonly segmentFlushMs: number;
  /** Per-key in-memory tail buffers awaiting seal (appendStreaming path). */
  private readonly buffers = new Map<string, SegmentBuffer>();
  /** Per-key sequential execution chain (serializes appendStreaming/finalize). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: S3LogStorageOptions) {
    this.bucket = options.bucket;
    this.prefix = options.prefix;
    this.segmentFlushBytes = options.segmentFlushBytes;
    this.segmentFlushMs = options.segmentFlushMs;
    this.client = createS3Client(options);
  }

  // -- Helpers --

  /**
   * Build the full S3 object key from a log path.
   *
   * The assert is not traversal protection — S3 keys are opaque byte strings,
   * so `..` is a literal segment and this concatenation cannot escape the
   * prefix. It refuses to mint a malformed key at all: `list()` and
   * `listWithMetadata()` rebuild storage-relative paths by slicing the prefix
   * off, so a key carrying `..` or a leading `/` would be handed back to the
   * caller as an odd relative path — and on a filesystem-backed peer that path
   * reaches a resolve. Keep it; it is deliberate.
   *
   * Removals do NOT go through here: see {@link S3LogStorage.deleteKey}.
   */
  private objectKey(path: string): string {
    assertSafeLogPath(path);
    return `${this.prefix}${path}`;
  }

  /**
   * Object key for a removal, built without the minting assert.
   *
   * `deleteMany` consumes this store's own `listWithMetadata()` output, which
   * reports whatever keys the bucket actually holds — including a legacy
   * malformed one written before `objectKey()` began refusing them. Routing a
   * removal through the minting assert would throw while building the batch,
   * so one such object would abort the whole retention sweep and leave every
   * expired object in place forever. There is no protection to lose: an S3 key
   * is an opaque byte string, so a `..` segment is literal and this
   * concatenation addresses an object inside the prefix or nothing at all.
   */
  private deleteKey(path: string): string {
    return `${this.prefix}${path}`;
  }

  /** Segment object key for a given sequence number (zero-padded to 6 digits). */
  private segKey(key: string, seq: number): string {
    return `${key}/seg-${String(seq).padStart(6, '0')}`;
  }

  /** Check if an error is a "not found" error (NoSuchKey, NotFound, 404). */
  private isNotFoundError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return true;
    const code = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return code === 404;
  }

  /** Read the full content of an S3 object as a string. Returns null if not found. */
  private async getContent(key: string): Promise<string | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      if (!response.Body) return null;

      const bytes = await response.Body.transformToByteArray();
      return Buffer.from(bytes).toString('utf-8');
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  }

  /**
   * Run `fn` after every previously-queued operation for `key` has settled, so
   * all appendStreaming/finalize calls for one step key execute strictly in
   * order. The chain swallows prior errors (they are surfaced to their own
   * caller) so one failed op does not wedge the key.
   */
  private runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // -- Write path (single-shot: immediately-durable read-modify-write) --

  async append(path: string, data: string): Promise<void> {
    const key = this.objectKey(path);

    // Read existing content (if any) and append new data
    const existing = await this.getContent(key);
    const newContent = existing !== null ? existing + data : data;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Buffer.from(newContent, 'utf-8'),
        ContentType: 'application/x-ndjson',
      }),
    );
  }

  // -- Write path (high-frequency step logs: buffered append-only segments) --

  /**
   * Highest existing segment number under a key (for mid-run redeploy
   * continuity), + 1. Returns 0 when no segments exist yet.
   */
  private async nextSeq(key: string): Promise<number> {
    let max = -1;
    let token: string | undefined;
    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${key}/seg-`,
          ContinuationToken: token,
        }),
      );
      for (const o of resp.Contents ?? []) {
        const m = o.Key?.match(/\/seg-(\d+)$/);
        if (m) max = Math.max(max, Number(m[1]));
      }
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    return max + 1;
  }

  /** Seal the buffer as the next immutable segment object. */
  private async seal(key: string, buf: SegmentBuffer): Promise<void> {
    if (buf.bytes === 0) return;
    const body = Buffer.concat(buf.chunks);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.segKey(key, buf.seq),
        Body: body,
        ContentType: 'application/x-ndjson',
      }),
    );
    buf.chunks = [];
    buf.bytes = 0;
    buf.seq += 1;
    buf.since = Date.now();
  }

  async appendStreaming(path: string, data: string): Promise<void> {
    const key = this.objectKey(path);
    await this.runExclusive(key, async () => {
      let buf = this.buffers.get(key);
      if (!buf) {
        buf = { chunks: [], bytes: 0, since: Date.now(), seq: 0, seqInit: false };
        this.buffers.set(key, buf);
      }
      if (!buf.seqInit) {
        buf.seq = await this.nextSeq(key);
        buf.seqInit = true;
      }
      const bytes = Buffer.from(data, 'utf-8');
      if (buf.bytes === 0) buf.since = Date.now();
      buf.chunks.push(bytes);
      buf.bytes += bytes.length;
      const aged = Date.now() - buf.since >= this.segmentFlushMs;
      if (buf.bytes >= this.segmentFlushBytes || aged) {
        await this.seal(key, buf);
      }
    });
  }

  async finalize(path: string): Promise<void> {
    const key = this.objectKey(path);
    await this.runExclusive(key, async () => {
      const buf = this.buffers.get(key);
      if (buf) {
        // On a transient seal failure the buffer is retained (runExclusive
        // surfaces the throw to the caller) so a later seal/finalize retries
        // the accumulated bytes rather than dropping them.
        await this.seal(key, buf);
        this.buffers.delete(key);
      }
    });
    // Drop the per-key chain so the map does not grow unbounded across a
    // long-running orchestrator; a rare post-finalize append recreates it.
    this.locks.delete(key);
  }

  // -- Read path --

  /**
   * Single-object size (or null) + sealed segments in ascending seq order for a
   * key. The single object is the content written by append() (single-shot
   * writers) or any legacy step log written before the append-only change.
   */
  private async layout(key: string): Promise<{ legacy: number | null; segs: Segment[] }> {
    let legacy: number | null = null;
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      legacy = head.ContentLength ?? 0;
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) throw err;
    }
    const segs: Segment[] = [];
    let token: string | undefined;
    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${key}/seg-`,
          ContinuationToken: token,
        }),
      );
      for (const o of resp.Contents ?? []) {
        if (o.Key) segs.push({ key: o.Key, size: o.Size ?? 0 });
      }
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    // Zero-padded seq means lexical order == numeric order.
    segs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { legacy, segs };
  }

  /** Fetch an inclusive byte range from one object. */
  private async getRange(key: string, start: number, end: number): Promise<Buffer> {
    const resp = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
    );
    if (!resp.Body) return Buffer.alloc(0);
    return Buffer.from(await resp.Body.transformToByteArray());
  }

  /**
   * Map a global byte cursor + limit onto per-object range reads across an
   * ordered entry list. Returns the reads to perform and the total byte size.
   */
  private planReads(
    entries: Segment[],
    cursor: number,
    limit?: number,
  ): { reads: RangeRead[]; total: number } {
    const total = entries.reduce((sum, e) => sum + e.size, 0);
    const reads: RangeRead[] = [];
    if (cursor >= total) return { reads, total };
    const readEnd = limit !== undefined ? Math.min(cursor + limit, total) : total; // exclusive
    let offset = 0;
    for (const e of entries) {
      const entryStart = offset;
      const entryEnd = offset + e.size; // exclusive
      offset = entryEnd;
      if (e.size === 0) continue;
      const from = Math.max(cursor, entryStart);
      const to = Math.min(readEnd, entryEnd); // exclusive
      if (from >= to) continue;
      reads.push({ key: e.key, start: from - entryStart, end: to - entryStart - 1 });
    }
    return { reads, total };
  }

  async read(path: string, options?: LogReadOptions): Promise<LogReadResult> {
    const key = this.objectKey(path);
    const cursor = options?.cursor ?? 0;
    const { legacy, segs } = await this.layout(key);

    const entries: Segment[] = [];
    if (legacy !== null) entries.push({ key, size: legacy });
    entries.push(...segs);

    const { reads, total } = this.planReads(entries, cursor, options?.limit);
    if (cursor >= total) {
      return { data: '', cursor: total, complete: true };
    }

    const buffers: Buffer[] = [];
    for (const r of reads) {
      buffers.push(await this.getRange(r.key, r.start, r.end));
    }
    const buf = Buffer.concat(buffers);
    const newCursor = cursor + buf.length;
    return {
      data: buf.toString('utf-8'),
      cursor: newCursor,
      complete: newCursor >= total,
    };
  }

  async exists(path: string): Promise<boolean> {
    const key = this.objectKey(path);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) throw err;
    }
    const resp = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${key}/seg-`, MaxKeys: 1 }),
    );
    return (resp.Contents?.length ?? 0) > 0;
  }

  async list(prefix: string): Promise<string[]> {
    const fullPrefix = this.objectKey(prefix);
    const logical = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of response.Contents ?? []) {
        if (!obj.Key) continue;
        // Collapse a segment key to its logical step path; single-object keys
        // already are logical paths and pass through unchanged.
        const logicalKey = obj.Key.replace(/\/seg-\d+$/, '');
        const relativePath = logicalKey.startsWith(this.prefix)
          ? logicalKey.slice(this.prefix.length)
          : logicalKey;
        logical.add(relativePath);
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return [...logical].sort();
  }

  async listWithMetadata(prefix: string): Promise<Array<{ path: string; lastModified: Date }>> {
    const fullPrefix = this.objectKey(prefix);
    const out: Array<{ path: string; lastModified: Date }> = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of response.Contents ?? []) {
        if (!obj.Key || !obj.LastModified) continue;
        // Physical object keys (segments and legacy single objects) are kept
        // as-is — the sweep deletes each one, so no seg-collapse here.
        const relativePath = obj.Key.startsWith(this.prefix)
          ? obj.Key.slice(this.prefix.length)
          : obj.Key;
        out.push({ path: relativePath, lastModified: obj.LastModified });
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return out;
  }

  async deleteMany(paths: string[]): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < paths.length; i += 1000) {
      const chunk = paths.slice(i, i + 1000);
      // Quiet:true suppresses the per-key success list but STILL returns any
      // per-key errors, so a partially-failed batch (e.g. one key access-
      // denied) is not miscounted as fully deleted and the object is not
      // silently reported as swept — count only what S3 actually removed.
      const response = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((p) => ({ Key: this.deleteKey(p) })), Quiet: true },
        }),
      );
      deleted += chunk.length - (response.Errors?.length ?? 0);
    }
    return deleted;
  }
}
