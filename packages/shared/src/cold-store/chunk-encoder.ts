/**
 * Chunk encoding / decoding.
 *
 * Each chunk is a newline-delimited JSON stream, gzipped. This format
 * is chosen for debuggability (grep + jq works on any chunk) over
 * columnar alternatives; see design doc section 3 for rationale.
 *
 * The encoder accumulates the gzipped body in memory. For Phase A that
 * is fine because we never call it (the framework has no adapters).
 * For Phase B, the eligibility SELECT is capped by `maxChunkBytes`
 * (default 50 MB, ceiling 100 MB for `execution_steps` / `run_events`),
 * so one chunk never exceeds a few hundred MB of uncompressed rows —
 * well within Node heap budgets.
 */
import { gzipSync } from 'node:zlib';
import { sha256 } from '@kici-dev/core';

export interface EncodedChunk {
  /** Gzipped JSONL body; ready to PutObject. */
  data: Buffer;
  /** sha256 hex of `data`. */
  contentHash: string;
  rowCount: number;
  /** Size of the uncompressed JSONL body (bytes). */
  byteCount: number;
  /** Size of `data` (bytes). */
  gzipByteCount: number;
  minRowId: string | number;
  maxRowId: string | number;
  /**
   * Exact row IDs that appear in this chunk, in stream (PK) order.
   * Used by the archive loop to drive `markArchivedAndDelete` — we
   * delete exactly what we encoded, never a range that might include
   * rows inserted after discovery.
   */
  rowIds: Array<string | number>;
  /** ISO timestamp — min of partition column across rows. */
  minTimestamp: string;
  /** ISO timestamp — max of partition column across rows. */
  maxTimestamp: string;
  /**
   * Phase F — natural-key lookup tokens (e.g. UUID `run_id`) for every
   * row in the chunk, populated only when the caller provided
   * `replayLookupKey`. Empty / undefined for tables that don't support
   * single-row replay.
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
   * Phase F — optional. When provided, the encoder collects the
   * returned token for every row into `replayLookupKeys`, which the
   * archive flow persists on the chunk's manifest. Returning
   * `undefined` for a row omits it from the index.
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
 * Decode a chunk back into a row stream.
 *
 * Implemented as a one-shot gunzip + split rather than an incremental
 * streaming parser because chunks are capped at ~100 MB compressed
 * (~500 MB uncompressed worst case) — well within memory for our
 * single-chunk rehydrate access pattern. A streaming decoder is added
 * in Phase B+ only if profiling shows heap pressure.
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

function compareRowIds(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  const as = String(a);
  const bs = String(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}
