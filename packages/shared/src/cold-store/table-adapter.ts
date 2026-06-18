/**
 * TableAdapter interface — the concrete per-table contract.
 *
 * Phase A shipped this interface with ZERO implementations. Phase B adds
 * `run_events`; Phase C adds `execution_runs` / `execution_jobs` /
 * `execution_steps`; etc. Each adapter lives next to its owning
 * package (`packages/{platform,orchestrator}/src/cold-store/tables/`)
 * and is registered on the respective `BaseColdStore` subclass.
 */
import type { ColdStoreTableConfig } from './config.js';
import type { DbKind } from './key.js';
import type { ColdRetention } from './types.js';

/**
 * Discovered (tenant, partition-day) tuple eligible for archival.
 * Yielded by `listEligiblePartitions` in PK-ordered streams.
 */
export interface EligiblePartition {
  tenantId: string;
  /** `YYYY-MM-DD`. */
  partitionDate: string;
}

/**
 * Arguments to `writeAuditAndChunkCount`. The adapter's implementation
 * is responsible for writing a row into whichever audit surface its DB
 * has (Platform → `audit_log`, Orchestrator → `access_log` in later
 * phases) AND upserting the per-(db, table, tenant) row in
 * `cold_store_chunk_counts` — both inside the same transaction as the
 * data-mutation in `markArchivedAndDelete`.
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
   * Phase 2 — present on chunks written by adapters that implement
   * `coldTtlDays(row)` (the per-bucket layout). Adapters use this to
   * INSERT a corresponding row into `cold_store_chunks` inside the same
   * transaction as the data delete + audit + rollup updates.
   *
   * Pre-Phase-2 (v1) chunks omit both fields — adapters skip the
   * `cold_store_chunks` insert in that case and the GC sweep treats
   * the chunk as `'forever'`.
   */
  bucket?: string;
  /** Phase 2 — see `bucket`. Numeric day-count or `'forever'`. */
  maxColdDays?: ColdRetention;
}

export interface TableAdapter<TRow> {
  readonly db: DbKind;
  /** Postgres table name the adapter archives. */
  readonly table: string;
  /** Column used to shard S3 keys (e.g. `org_id`, `routing_key`). */
  readonly tenantColumn: string;
  /** Column used for day-partitioning (e.g. `created_at`). */
  readonly partitionColumn: string;
  /** Effective per-table config after merging defaults + overrides. */
  readonly config: ColdStoreTableConfig;

  /**
   * Stream the distinct (tenant, partitionDate) combinations that carry
   * rows older than `warmCutoff`. The framework iterates these and,
   * per combination, calls `selectEligible` inside `withPartitionLock`.
   *
   * Order: `(tenantId, partitionDate)` ascending. This lets the
   * framework pause mid-iteration at a byte / row cap and resume on
   * the next cycle without skipping partitions.
   */
  listEligiblePartitions(args: { warmCutoff: Date }): AsyncIterable<EligiblePartition>;

  /**
   * Approximate size-in-bytes of warm rows for a single tenant.
   * Used to enforce `minWarmTenantBytes` — we skip archival for
   * low-traffic tenants where the chunk would be tiny.
   *
   * Implementations MAY approximate via `pg_column_size` sum + row
   * count; accuracy within ~20% is fine.
   */
  countTenantWarmBytes(args: { tenantId: string; warmCutoff: Date }): Promise<number>;

  /**
   * Run `fn` while holding a Postgres advisory lock keyed by
   * `hashtext('cold-store|<db>|<table>|<tenantId>|<partitionDate>')`.
   *
   * Returns the `fn` result on successful lock acquisition, or `null`
   * when another archiver replica already holds the lock. The adapter
   * owns this because the lock lives on its Kysely instance.
   *
   * Implementations SHOULD use `pg_try_advisory_xact_lock` inside a
   * short-lived transaction so the lock is auto-released on commit
   * or rollback.
   */
  withPartitionLock<T>(
    args: { tenantId: string; partitionDate: string },
    fn: () => Promise<T>,
  ): Promise<T | null>;

  /**
   * Stream the eligible rows for one (tenant, partitionDate) combination,
   * up to the adapter's byte/row cap. Rows yielded in PK order so min/max
   * bounds are computed correctly.
   */
  selectEligible(args: {
    tenantId: string;
    partitionDate: string;
    limit: number;
  }): AsyncIterable<TRow>;

  /** Stringify a row for the JSONL body. */
  encodeRow(row: TRow): string;
  /** Parse a row back from a JSONL line. */
  decodeRow(line: string): TRow;
  /** Extract the primary key; used for chunk-id bounds. */
  rowId(row: TRow): string | number;
  /** Extract the partition-column timestamp; used for manifest bounds. */
  rowTimestamp(row: TRow): Date | string;

  /**
   * Phase F — optional natural-key extractor used by
   * `BaseColdStore.replayRow()` to find a chunk by an externally
   * meaningful identifier (e.g. UUID `run_id`) rather than the internal
   * SERIAL `id` returned by `rowId()`. Adapters that implement this
   * method opt the table into single-row replay-into-PG: every chunk
   * persisted afterwards carries a `replayLookupKeys` array on its
   * manifest. Adapters whose primary key already IS the natural key
   * (e.g. `event_log` keyed by UUID) can leave this undefined — the
   * `minRowId`/`maxRowId` range comparison covers them.
   */
  replayLookupKey?(row: TRow): string;

  /**
   * Transactionally:
   *  1. `UPDATE <table> SET archived_at = now(), archive_object_key = <objectKey> WHERE id IN (<rowIds>)`.
   *  2. `DELETE FROM <table> WHERE id IN (<rowIds>)`.
   *  3. Call `writeAuditAndChunkCount` with `chunkMeta` on the same
   *     transaction handle (adapter-internal wiring).
   *
   * Implemented inside each adapter because the row-ID column name
   * varies per table.
   */
  markArchivedAndDelete(args: {
    rowIds: ReadonlyArray<string | number>;
    chunkMeta: ChunkCommitMetadata;
  }): Promise<void>;

  /**
   * Phase F — replay a chunk's rows back into PG.
   *
   * Optional. Adapters that do NOT implement this method cannot be
   * promoted back into PG via `BaseColdStore.replayChunk()` /
   * `replayRow()` — only those tables whose rerun / rehydrate path
   * genuinely needs read-after-write semantics on PG (currently only
   * `execution_runs` on both DBs) opt in.
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
   * Returns `{ inserted, skipped }`. `skipped` covers rows whose unique
   * key already exists in PG (idempotent replays — fine).
   */
  replayInsert?(args: {
    rows: ReadonlyArray<TRow>;
    chunkMeta: ChunkCommitMetadata;
  }): Promise<{ inserted: number; skipped: number }>;

  /**
   * Phase 2 — per-row cold-retention TTL.
   *
   * Returns the number of days the row's chunk should live in S3 after
   * archival, or `'forever'` to never purge. The framework groups rows by
   * `coldDaysToBucket(coldTtlDays(row))` at archive time so each chunk
   * spans a single bucket subprefix; the chunk's manifest carries the
   * MAXIMUM `coldTtlDays` of any row in the chunk so the GC sweep keys
   * off row-level retention rather than the bucket name.
   *
   * Adapters that don't implement this method opt out of the per-bucket
   * layout: every chunk is written to the day-prefix root with the
   * legacy v1 manifest and is treated as `'forever'` by the GC sweep.
   * Audit-style adapters (`audit_log`, `access_log`, `secret_audit_log`)
   * implement this; the high-volume execution / event tables retain
   * their existing layout until their own retention policy is finalized.
   */
  coldTtlDays?(row: TRow): ColdRetention;

  /**
   * Phase 2 — transactionally purge a chunk's PG bookkeeping after the
   * S3 objects have been deleted.
   *
   * Implementations MUST run all three steps in one transaction so a
   * partial failure doesn't leave inconsistent state:
   *   1. `DELETE FROM cold_store_chunks WHERE chunk_id = $1`.
   *   2. Decrement `cold_store_chunk_counts` (`chunk_count -= 1`,
   *      `total_bytes -= gzipBytes`, `total_rows -= rowCount`,
   *      floored at 0 so a purge-then-rearchive doesn't underflow).
   *   3. INSERT a `'purge_chunk'` audit row into the adapter's audit
   *      surface (Platform → `audit_log`, Orchestrator → `access_log`)
   *      with `actor_id='cold-store-purge:<instanceId>'` and details
   *      `{ bucket, maxColdDays, gzipBytes, rowCount, objectKey }`.
   *
   * Optional — adapters that don't opt into the per-bucket layout via
   * `coldTtlDays` also can't be purged, so they don't need this hook.
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
