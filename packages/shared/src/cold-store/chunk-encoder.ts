/**
 * A chunk is gzipped JSONL, chosen over columnar formats so grep + jq work on
 * any chunk. The body is built in memory: `maxChunkBytes` (default 50 MB,
 * ceiling 100 MB for `execution_steps` / `run_events`) caps the eligibility
 * SELECT, so a chunk stays within a few hundred MB uncompressed.
 */
import { gzipSync } from 'node:zlib';
import { sha256 } from '@kici-dev/core';

export interface EncodedChunk {
  /** Gzipped JSONL body, ready to PutObject. */
  data: Buffer;
  /** sha256 hex of `data`. */
  contentHash: string;
  rowCount: number;
  /** Uncompressed body size, bytes. */
  byteCount: number;
  /** `data` size, bytes. */
  gzipByteCount: number;
  minRowId: string | number;
  maxRowId: string | number;
  /**
   * Exact row IDs in stream (PK) order, passed to `markArchivedAndDelete` so the
   * delete covers exactly what was encoded, never a range that could include
   * rows inserted after discovery.
   */
  rowIds: Array<string | number>;
  /** ISO; min / max of the partition column across rows. */
  minTimestamp: string;
  maxTimestamp: string;
  /**
   * Natural-key tokens (e.g. UUID `run_id`) per row; set only when the caller
   * passed `replayLookupKey`.
   */
  replayLookupKeys?: string[];
}

export interface EncodeChunkArgs<TRow> {
  rows: AsyncIterable<TRow>;
  /** Defaults to `JSON.stringify`. */
  encodeRow?: (row: TRow) => string;
  rowId: (row: TRow) => string | number;
  rowTimestamp: (row: TRow) => Date | string;
  /**
   * Tokens go into `replayLookupKeys`, which the archive flow persists on the
   * manifest; `undefined` omits the row from the index.
   */
  replayLookupKey?: (row: TRow) => string | undefined;
}

export async function encodeChunk<TRow>(args: EncodeChunkArgs<TRow>): Promise<EncodedChunk> {
  const encode = args.encodeRow ?? ((r: TRow) => JSON.stringify(r));

  const lines: string[] = [];
  const rowIds: Array<string | number> = [];
  const replayLookupKeys: string[] = [];
  const replayLookupKey = args.replayLookupKey;
  let rowCount = 0;
  let minRowId: string | number | null = null;
  let maxRowId: string | number | null = null;
  let minTs: Date | null = null;
  let maxTs: Date | null = null;

  for await (const row of args.rows) {
    lines.push(encode(row));
    rowCount += 1;
    const rid = args.rowId(row);
    rowIds.push(rid);
    if (replayLookupKey) {
      const tok = replayLookupKey(row);
      if (tok !== undefined) replayLookupKeys.push(tok);
    }
    if (minRowId === null || compareRowIds(rid, minRowId) < 0) minRowId = rid;
    if (maxRowId === null || compareRowIds(rid, maxRowId) > 0) maxRowId = rid;
    const ts = toDate(args.rowTimestamp(row));
    if (minTs === null || ts < minTs) minTs = ts;
    if (maxTs === null || ts > maxTs) maxTs = ts;
  }

  if (rowCount === 0) {
    throw new Error('encodeChunk: empty row stream; caller must guard against this');
  }

  const uncompressed = Buffer.from(lines.join('\n') + '\n', 'utf-8');
  const gzipped = gzipSync(uncompressed);

  return {
    data: gzipped,
    contentHash: sha256(gzipped),
    rowCount,
    byteCount: uncompressed.byteLength,
    gzipByteCount: gzipped.byteLength,
    minRowId: minRowId!,
    maxRowId: maxRowId!,
    rowIds,
    minTimestamp: minTs!.toISOString(),
    maxTimestamp: maxTs!.toISOString(),
    replayLookupKeys: replayLookupKey && replayLookupKeys.length > 0 ? replayLookupKeys : undefined,
  };
}

export interface DecodeChunkArgs<TRow> {
  /** Already-gzipped body (whole chunk). */
  gzipped: Buffer;
  /** Defaults to `JSON.parse`. */
  decodeLine?: (line: string) => TRow;
}

/**
 * One-shot gunzip + split, not a streaming parser: chunks are capped at ~100 MB
 * compressed (~500 MB uncompressed worst case), which fits memory for
 * single-chunk rehydrate. Stream only if profiling shows heap pressure.
 */
export async function* decodeChunk<TRow>(args: DecodeChunkArgs<TRow>): AsyncIterable<TRow> {
  const { gunzipSync } = await import('node:zlib');
  const parse = args.decodeLine ?? ((line: string) => JSON.parse(line) as TRow);
  const text = gunzipSync(args.gzipped).toString('utf-8');
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    yield parse(line);
  }
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * Order row ids the way chunk bounds are computed: numerically when both are
 * numbers, else by string. `computeChunkId` hashes these bounds, so any code
 * that re-derives a chunk id must order ids with this function.
 */
export function compareRowIds(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  const as = String(a);
  const bs = String(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}
