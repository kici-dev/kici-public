/**
 * The per-table cold-store contract. Each adapter lives in its owning package
 * (`packages/{platform,orchestrator}/src/cold-store/tables/`) and is registered
 * on that package's `BaseColdStore` subclass.
 */
import type { ColdStoreTableConfig } from './config.js';
import type { DbKind } from './key.js';
import type { ColdRetention } from './types.js';

/** A (tenant, partition-day) eligible for archival, yielded by `listEligiblePartitions` in PK order. */
export interface EligiblePartition {
  tenantId: string;
  /** `YYYY-MM-DD`. */
  partitionDate: string;
}

/**
 * Arguments to `writeAuditAndChunkCount`, which writes an audit row (Platform →
 * `audit_log`, Orchestrator → `access_log`) and upserts the per-(db, table,
 * tenant) `cold_store_chunk_counts` row, both in the `markArchivedAndDelete`
 * transaction.
 */
export interface ChunkCommitMetadata {
  chunkId: string;
  tenantId: string;
  partitionDate: string;
  rowCount: number;
  byteCount: number;
  gzipByteCount: number;
  objectKey: string;
  /**
   * Set only by adapters that implement `coldTtlDays(row)` (the per-bucket
   * layout); the adapter then inserts a `cold_store_chunks` row in the same
   * transaction as the delete, audit and rollup updates. V1 chunks omit both
   * fields: no `cold_store_chunks` insert, and the GC sweep treats the chunk as
   * `'forever'`.
   */
  bucket?: string;
  /** See `bucket`. Numeric day-count or `'forever'`. */
  maxColdDays?: ColdRetention;
}

export interface TableAdapter<TRow> {
  readonly db: DbKind;
  readonly table: string;
  /** Column used to shard S3 keys (e.g. `org_id`, `routing_key`). */
  readonly tenantColumn: string;
  /** Column used for day-partitioning (e.g. `created_at`). */
  readonly partitionColumn: string;
  /** Defaults merged with per-table overrides. */
  readonly config: ColdStoreTableConfig;

  /**
   * Distinct (tenant, partitionDate) pairs with rows older than `warmCutoff`;
   * the framework calls `selectEligible` per pair inside `withPartitionLock`.
   * Ascending `(tenantId, partitionDate)` order lets the framework stop at a
   * byte / row cap and resume next cycle without skipping partitions.
   */
  listEligiblePartitions(args: { warmCutoff: Date }): AsyncIterable<EligiblePartition>;

  /**
   * Approximate warm-row bytes for one tenant, for `minWarmTenantBytes` (skip
   * archival when the chunk would be tiny). A `pg_column_size` sum plus row
   * count is fine; ~20% accuracy suffices.
   */
  countTenantWarmBytes(args: { tenantId: string; warmCutoff: Date }): Promise<number>;

  /**
   * Run `fn` while holding a Postgres advisory lock keyed by
   * `hashtext('cold-store|<db>|<table>|<tenantId>|<partitionDate>')`.
   *
   * Returns `null` when another archiver replica holds the lock. The adapter
   * owns this because the lock lives on its Kysely instance.
   *
   * `PgTableAdapterBase` implements it with a session lock
   * (`pg_try_advisory_lock`) on one pinned connection, released in a
   * `finally`, so the archive body can run its own transactions on the pool.
   */
  withPartitionLock<T>(
    args: { tenantId: string; partitionDate: string },
    fn: () => Promise<T>,
  ): Promise<T | null>;

  /**
   * Eligible rows for one (tenant, partitionDate), up to the byte/row cap, in
   * PK order so the min/max bounds are correct.
   */
  selectEligible(args: {
    tenantId: string;
    partitionDate: string;
    limit: number;
  }): AsyncIterable<TRow>;

  /** JSONL line codec. */
  encodeRow(row: TRow): string;
  decodeRow(line: string): TRow;
  /** Primary key; used for chunk-id bounds. */
  rowId(row: TRow): string | number;
  /** Partition-column timestamp; used for manifest bounds. */
  rowTimestamp(row: TRow): Date | string;

  /**
   * Natural key (e.g. UUID `run_id`, not the SERIAL `rowId()`) that
   * `BaseColdStore.replayRow()` finds a chunk by. Implementing it opts the table
   * into single-row replay: every chunk written afterwards carries
   * `replayLookupKeys` on its manifest. Omit it when the PK is already the
   * natural key (e.g. `event_log`); the `minRowId`/`maxRowId` range covers it.
   */
  replayLookupKey?(row: TRow): string;

  /**
   * Transactionally:
   *  1. `UPDATE <table> SET archived_at = now(), archive_object_key = <objectKey> WHERE id IN (<rowIds>)`.
   *  2. `DELETE FROM <table> WHERE id IN (<rowIds>)`.
   *  3. Call `writeAuditAndChunkCount` with `chunkMeta` on the same
   *     transaction handle (adapter-internal wiring).
   *
   * Per adapter because the row-ID column name varies per table.
   */
  markArchivedAndDelete(args: {
    rowIds: ReadonlyArray<string | number>;
    chunkMeta: ChunkCommitMetadata;
  }): Promise<void>;

  /**
   * Replay a chunk's rows back into PG. Without it, `BaseColdStore.replayChunk()`
   * / `replayRow()` cannot promote the table; only tables whose rerun /
   * rehydrate path needs read-after-write on PG (`execution_runs` on both DBs)
   * opt in.
   *
   * Contract:
   *  1. INSERT each row, clearing `archived_at` / `archive_object_key`,
   *     `ON CONFLICT ON the natural unique key DO NOTHING` so a duplicate
   *     replay is a no-op. Exact unique key varies per table (e.g.
   *     `run_id` for `execution_runs`).
   *  2. Write a "replay" audit row to whichever audit surface the DB has
   *     (`audit_log` for Platform, `access_log` for Orchestrator).
   *     `actor_id='cold-store-replay:<instanceId>'`,
   *     `action='replay_chunk'`, `target_id=<chunkId>`.
   *  3. Decrement `cold_store_chunk_counts` for the (db, table, tenant):
   *     `chunk_count = chunk_count - 1`,
   *     `total_rows  = total_rows  - <inserted>`,
   *     `total_bytes = total_bytes - <gzipByteCount>`. Floors at 0 so a
   *     replay-then-rearchive cycle doesn't underflow.
   *
   * All three steps run in one transaction — either everything commits
   * or nothing does.
   *
   * `skipped` counts rows whose unique key already exists in PG.
   */
  replayInsert?(args: {
    rows: ReadonlyArray<TRow>;
    chunkMeta: ChunkCommitMetadata;
  }): Promise<{ inserted: number; skipped: number }>;

  /**
   * Days the row's chunk lives in S3 after archival, or `'forever'`. Rows are
   * grouped by `coldDaysToBucket(coldTtlDays(row))` so each chunk spans one
   * bucket subprefix; the manifest carries the chunk's MAXIMUM `coldTtlDays`, so
   * the GC sweep keys off row retention, not the bucket name.
   *
   * Without it, every chunk goes to the day-prefix root with the v1 manifest and
   * the GC sweep treats it as `'forever'`. The audit-style adapters (`audit_log`,
   * `access_log`, `secret_audit_log`) implement it; the high-volume execution /
   * event tables do not.
   */
  coldTtlDays?(row: TRow): ColdRetention;

  /**
   * Purge a chunk's PG bookkeeping after its S3 objects are deleted. All steps
   * MUST run in one transaction:
   *   1. `DELETE FROM cold_store_chunks WHERE chunk_id = $1`.
   *   2. Decrement `cold_store_chunk_counts` (`chunk_count -= 1`,
   *      `total_bytes -= gzipBytes`, `total_rows -= rowCount`,
   *      floored at 0 so a purge-then-rearchive doesn't underflow).
   *   3. INSERT a `'purge_chunk'` audit row into the adapter's audit
   *      surface (Platform → `audit_log`, Orchestrator → `access_log`)
   *      with `actor_id='cold-store-purge:<instanceId>'` and details
   *      `{ bucket, maxColdDays, gzipBytes, rowCount, objectKey }`.
   *
   * Only adapters that implement `coldTtlDays` can be purged, so only they need it.
   */
  purgeChunkRecord?(args: {
    tenantId: string;
    chunkId: string;
    gzipBytes: number;
    rowCount: number;
    bucket: string;
    maxColdDays: number;
    objectKey: string;
  }): Promise<void>;
}
