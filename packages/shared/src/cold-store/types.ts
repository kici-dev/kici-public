/**
 * Shapes the DB-agnostic cold-storage archival framework exchanges with its
 * consumers (Platform, Orchestrator).
 */
import type { DbKind } from './key.js';

/**
 * Cold-retention horizon for a chunk: number of days the chunk lives in S3
 * after archival before being purged, or `'forever'` to never purge.
 */
export type ColdRetention = number | 'forever';

/**
 * Sidecar manifest written next to every archived chunk.
 *
 * The manifest is the authoritative description of a chunk: callers
 * MUST rely on it (not on file listings) to decide whether to rehydrate
 * a given chunk for a range query. The `contentHash` field lets the
 * `verify-chunk` CLI detect bit-rot or mutation without re-reading the
 * body at ingestion time.
 */
export interface ChunkManifest {
  /**
   * Manifest schema version.
   *
   * - `1`: no bucket or cold-TTL metadata; treated as `bucket='forever'` /
   *   `maxColdDays='forever'`, so the GC sweep never purges it.
   * - `2`: adds `bucket` (S3 segment) and `maxColdDays` (numeric or
   *   `'forever'`). The GC sweep keys off `archivedAt + maxColdDays`, NOT the
   *   bucket name — actions with different per-row TTLs can share a bucket.
   */
  schemaVersion: 1 | 2;
  db: DbKind;
  /** Postgres table name the chunk was sourced from. */
  table: string;
  /** `org_id` for Platform tables, `routing_key` for Orchestrator tables. */
  tenantId: string;
  /** `YYYY-MM-DD`. Derived from the table's partition column. */
  partitionDate: string;
  rowCount: number;
  /** Size of the uncompressed JSONL body. */
  byteCount: number;
  /** Size of the gzipped data file. */
  gzipByteCount: number;
  /** Min of the partition column (ISO) across rows in this chunk. */
  minTimestamp: string;
  /** Max of the partition column (ISO) across rows in this chunk. */
  maxTimestamp: string;
  /** Min PK in the chunk (string or numeric, matches adapter output). */
  minRowId: string | number;
  /** Max PK in the chunk. */
  maxRowId: string | number;
  /** sha256 hex of the gzipped body. */
  contentHash: string;
  /** Filename-stem of the chunk; matches the deterministic ID. */
  chunkId: string;
  /** ISO wall clock at archive time. */
  createdAt: string;
  /** Instance ID of the archiver process, for forensics. */
  archiverInstanceId: string;
  /**
   * Natural-key lookup tokens (e.g. UUID `run_id`) for every row, present when
   * the adapter implements `replayLookupKey()`. `BaseColdStore.replayRow()`
   * uses them to find a natural key when `minRowId`/`maxRowId` are an internal
   * SERIAL `id` callers don't have; without them it falls back to the
   * `minRowId`/`maxRowId` range comparison.
   */
  replayLookupKeys?: string[];
  /**
   * S3 prefix segment under the `<tenant>/<YYYY>/<MM>/<DD>/`
   * day directory. Examples: `'30d'`, `'180d'`, `'1y'`, `'2y'`, `'forever'`.
   * V1 manifests omit this; the framework treats them as `'forever'`.
   */
  bucket?: string;
  /**
   * Maximum per-row cold TTL (days, or `'forever'`) across the chunk's rows.
   * The GC sweep purges a chunk when `now > archivedAt + maxColdDays * 86_400_000`,
   * and MUST use this field, not the bucket name, since actions with different
   * per-row TTLs can share a bucket.
   */
  maxColdDays?: ColdRetention;
}

/**
 * Return value of `ColdStore.runArchiveCycle()`.
 *
 * A store with no registered adapters reports zero work with
 * `skipped.no_tables = 1` to signal "framework alive, no adapters
 * registered".
 */
export interface ArchiveCycleSummary {
  tablesProcessed: number;
  chunksWritten: number;
  rowsArchived: number;
  rowsFailed: number;
  skipped: {
    disabled: number;
    min_chunk: number;
    min_warm: number;
    no_tables: number;
  };
}
