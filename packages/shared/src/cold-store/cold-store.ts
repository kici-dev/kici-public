/**
 * BaseColdStore — the DB-agnostic framework class.
 *
 * Multiple concrete subclasses extend this one (e.g., `PlatformColdStore`,
 * `OrchestratorColdStore`). Each wires the adapter map with its
 * package-specific adapters.
 *
 * Phase B: `runArchiveCycle()` now drives the per-adapter archive loop
 * (design §4). `fetchRange` / `hasRange` / `countRange` are real — they
 * resolve manifests via `ListObjectsV2` and GET overlapping chunks
 * through an in-process LRU.
 *
 * ## Advisory-lock namespace
 *
 * All Postgres advisory locks acquired by the cold-store framework use
 * keys derived from `hashtext('cold-store|...')`. The `cold-store|`
 * prefix is reserved — do NOT reuse it in pipeline or engine code
 * without coordinating to avoid collisions.
 *
 * ## S3 bucket versioning caveat
 *
 * When the cold-store bucket has versioning ON (recommended default),
 * retried chunk PUTs produce new object versions at the same key.
 * Reconciliation (the `reconcile` CLI) MUST use `ListObjectVersions`,
 * not `ListObjects`, to detect orphaned objects correctly. The live
 * read-through uses `ListObjectsV2` because it only cares about the
 * current version of each manifest.
 */
import {
  type S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { sha256 } from '@kici-dev/core';
import { createS3Client } from '../s3-client.js';
import { coldDaysToBucket, isLongerColdRetention } from './bucket.js';
import { computeChunkId } from './chunk-id.js';
import { encodeChunk, decodeChunk, type EncodedChunk } from './chunk-encoder.js';
import {
  chunkObjectKey,
  encodeKeySegment,
  tablePrefix,
  tenantDayPrefix,
  type DbKind,
} from './key.js';
import type { ChunkLru } from './lru.js';
import { parseManifest, serializeManifest } from './manifest.js';
import {
  coldStoreArchiveBytesTotal,
  coldStoreArchiveCyclesTotal,
  coldStoreArchiveDurationSeconds,
  coldStoreArchiveRowsTotal,
  coldStorePurgeBytesTotal,
  coldStorePurgeChunksTotal,
  coldStorePurgeDurationSeconds,
  coldStoreRehydrateBytesTotal,
  coldStoreRehydrateDurationSeconds,
  coldStoreRehydrateRequestsTotal,
  coldStoreReplayDurationSeconds,
  coldStoreReplayRowsTotal,
  coldStoreVerifyFailuresTotal,
} from './metrics.js';
import type { ColdStoreConfig } from './config.js';
import type { ChunkCommitMetadata, TableAdapter } from './table-adapter.js';
import type { ArchiveCycleSummary, ChunkManifest, ColdRetention } from './types.js';

const CONTENT_HASH_META = 'content-hash';

export interface ColdStoreFetchRangeArgs<TRow> {
  db: DbKind;
  table: string;
  tenantId: string;
  fromTs: Date;
  toTs: Date;
  decode?: (line: string) => TRow;
}

export interface ColdStoreReplayChunkArgs {
  db: DbKind;
  table: string;
  tenantId: string;
  partitionDate: string;
  chunkId: string;
}

export interface ColdStoreReplayRowArgs {
  db: DbKind;
  table: string;
  tenantId: string;
  rowId: string | number;
}

export interface ColdStoreReplayResult {
  /** Number of rows newly inserted into PG. */
  inserted: number;
  /** Rows whose unique key was already in PG (idempotent re-replay). */
  skipped: number;
  /** The chunk that was replayed (`null` when replayRow finds no match). */
  chunkId: string | null;
}

/**
 * Phase 2 — purge-sweep options.
 *
 * `tableFilter` restricts to a single table (used by
 * `cold-store purge-now <table>`). `bucketFilter` further restricts to a
 * single bucket subprefix. `limit` caps the number of chunks processed
 * per call so a single sweep can't OOM the orchestrator on a tenant
 * with millions of expired chunks. `dryRun=true` lists candidates
 * without actually deleting anything (the CLI default — operators must
 * pass `--apply`).
 */
export interface PurgeExpiredChunksOpts {
  tableFilter?: string;
  bucketFilter?: string;
  limit?: number;
  dryRun?: boolean;
}

/**
 * Phase 2 — one row per (chunk attempt, outcome). Returned from
 * `purgeExpiredChunks` so callers (scheduled job, CLI) can log / report
 * what happened without re-querying the chunk index.
 */
export interface PurgeChunkResult {
  table: string;
  tenantId: string;
  chunkId: string;
  bucket: string;
  gzipBytes: number;
  rowCount: number;
  outcome: 'purged' | 'dry_run' | 'skipped_locked' | 'failure';
  /** Populated only when `outcome === 'failure'`. */
  error?: string;
}

export interface PurgeExpiredChunksSummary {
  results: PurgeChunkResult[];
  /** Total bytes (gzipped) actually purged from S3. */
  bytesPurged: number;
  /** Total chunks actually purged (i.e., outcome === 'purged'). */
  chunksPurged: number;
  /** Wall-clock duration of the whole sweep. */
  durationMs: number;
}

/**
 * Phase 2 — chunk-index row shape returned by
 * `BaseColdStore.listPurgeableChunks`. Mirrors `cold_store_chunks` row
 * with a normalized `maxColdDays` field.
 */
export interface PurgeableChunk {
  table: string;
  tenantId: string;
  chunkId: string;
  bucket: string;
  archivedAt: Date;
  gzipBytes: number;
  rowCount: number;
  maxColdDays: number;
  objectKey: string;
}

/**
 * Public cold-store API. Phase B implements all four core methods.
 * Phase F adds `replayChunk` / `replayRow` for the rerun-from-archive
 * flow.
 */
export interface ColdStore {
  /** Stream archived rows that overlap [fromTs, toTs). */
  fetchRange<TRow>(args: ColdStoreFetchRangeArgs<TRow>): AsyncIterable<TRow>;
  hasRange(args: Omit<ColdStoreFetchRangeArgs<unknown>, 'decode'>): Promise<boolean>;
  countRange(args: Omit<ColdStoreFetchRangeArgs<unknown>, 'decode'>): Promise<number>;
  /**
   * Run one archive cycle. By default iterates every registered adapter
   * in registration order; pass `tableFilter` to restrict to a single
   * adapter (used by `archive-now <table>` CLI commands so an operator
   * can flush one table on demand without waiting for the next cron tick).
   */
  runArchiveCycle(opts?: { tableFilter?: string }): Promise<ArchiveCycleSummary>;
  /**
   * Phase F — promote every row in a chunk back into PG transactionally.
   * Idempotent on re-run via the adapter's `ON CONFLICT DO NOTHING`.
   * Throws if the adapter doesn't implement `replayInsert`, the chunk
   * is missing, or the contentHash check fails.
   */
  replayChunk(args: ColdStoreReplayChunkArgs): Promise<ColdStoreReplayResult>;
  /**
   * Phase F — locate the chunk containing `rowId` (via manifest
   * `minRowId`/`maxRowId` bounds) and replay it. Returns
   * `chunkId: null` when no manifest matches — caller handles as
   * "row truly does not exist anywhere".
   */
  replayRow(args: ColdStoreReplayRowArgs): Promise<ColdStoreReplayResult>;
  /**
   * Phase 2 — purge expired chunks from S3.
   *
   * Looks up `cold_store_chunks` rows where
   * `now() > archived_at + max_cold_days * INTERVAL '1 day'` AND
   * `max_cold_days != 'forever'`. For each:
   *   1. Acquire a per-chunk advisory lock so concurrent sweeps can't
   *      double-delete.
   *   2. Issue `DeleteObject` for both the data and manifest keys.
   *   3. Call `adapter.purgeChunkRecord(...)` to transactionally delete
   *      the row from `cold_store_chunks`, decrement the rollup, and
   *      write a `purge_chunk` audit row.
   *
   * `dryRun=true` (CLI default) skips steps 2–3 and returns the
   * candidate list without mutating anything. Production scheduled
   * sweeps pass `dryRun=false`.
   */
  purgeExpiredChunks(opts?: PurgeExpiredChunksOpts): Promise<PurgeExpiredChunksSummary>;
}

export interface BaseColdStoreDeps {
  db: DbKind;
  config: ColdStoreConfig;
  instanceId: string;
  /** Caller-supplied logger-like callable; omits pull on shared logger. */
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** Caller-supplied LRU; shared across consumers if desired. */
  chunkCache?: ChunkLru<string, Buffer>;
  /**
   * Pre-built S3 client. If omitted, the BaseColdStore constructs one
   * from `config.storage` via `createS3Client`. Tests pass a mock.
   */
  s3Client?: S3Client;
}

export abstract class BaseColdStore implements ColdStore {
  protected readonly db: DbKind;
  protected readonly config: ColdStoreConfig;
  protected readonly instanceId: string;
  protected readonly log: BaseColdStoreDeps['log'];
  protected readonly chunkCache: ChunkLru<string, Buffer> | undefined;
  protected readonly s3: S3Client;
  /** Registered table adapters by `table` name. */
  protected readonly adapters: Map<string, TableAdapter<unknown>> = new Map();

  protected constructor(deps: BaseColdStoreDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.instanceId = deps.instanceId;
    this.log = deps.log;
    this.chunkCache = deps.chunkCache;
    this.s3 =
      deps.s3Client ??
      createS3Client({
        region: deps.config.storage.region,
        endpoint: deps.config.storage.endpoint,
        forcePathStyle: deps.config.storage.forcePathStyle,
      });
  }

  /**
   * Register a concrete table adapter. Subclasses typically call this
   * from their constructor.
   */
  protected registerAdapter(adapter: TableAdapter<unknown>): void {
    if (adapter.db !== this.db) {
      throw new Error(
        `BaseColdStore: adapter db=${adapter.db} does not match cold-store db=${this.db}`,
      );
    }
    if (this.adapters.has(adapter.table)) {
      throw new Error(`BaseColdStore: duplicate adapter for table ${adapter.table}`);
    }
    this.adapters.set(adapter.table, adapter);
  }

  /** Test / CLI helper — adapter-map read access. */
  getAdapter(table: string): TableAdapter<unknown> | undefined {
    return this.adapters.get(table);
  }
  listAdapters(): ReadonlyArray<TableAdapter<unknown>> {
    return Array.from(this.adapters.values());
  }

  /**
   * CLI-accessible S3 primitives. Exposed so admin CLI commands can run
   * inspection / reconciliation operations without a direct dependency
   * on `@aws-sdk/client-s3`. Not intended for hot-path use.
   */
  get bucket(): string {
    return this.config.storage.bucket;
  }
  get storagePrefix(): string {
    return this.config.storage.prefix;
  }

  /** List all object keys under a prefix, paging internally. */
  async listObjectKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const resp = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.config.storage.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );
      for (const obj of resp.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  /** Fetch an object's raw body as a Buffer. */
  async getObjectBody(key: string): Promise<Buffer> {
    const resp = await this.s3.send(
      new GetObjectCommand({ Bucket: this.config.storage.bucket, Key: key }),
    );
    if (!resp.Body) throw new Error(`cold-store: empty body for ${key}`);
    const bytes = await resp.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  /** Upload a manifest JSON object at `key`. */
  async putManifestObject(key: string, manifest: ChunkManifest): Promise<void> {
    return this.putManifest(key, manifest);
  }

  /**
   * Delete a single object by key. CLI-accessible companion to
   * `listObjectKeys` / `getObjectBody`, used by tenant-scoped sweep
   * paths (e.g. the post-`deleteOrgCascade` S3 cleanup) that operate
   * on chunks the index already forgot about. Does NOT touch the
   * `cold_store_chunks` index — callers that need both must follow
   * the `purgeExpiredChunks` pattern with `withPurgeLock` +
   * `adapter.purgeChunkRecord`.
   */
  async deleteObject(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.storage.bucket, Key: key }));
  }

  // ── Archive cycle ──────────────────────────────────────────────────

  async runArchiveCycle(opts?: { tableFilter?: string }): Promise<ArchiveCycleSummary> {
    const start = Date.now();
    const summary: ArchiveCycleSummary = {
      tablesProcessed: 0,
      chunksWritten: 0,
      rowsArchived: 0,
      rowsFailed: 0,
      skipped: { disabled: 0, min_chunk: 0, min_warm: 0, no_tables: 0 },
    };

    if (!this.config.enabled) {
      this.log('info', 'cold-store cycle skipped: disabled by config', {
        db: this.db,
        instanceId: this.instanceId,
      });
      summary.skipped.disabled += 1;
      // Non-zero bump so the `kici-cold-store` meter scope + this
      // counter are visible on /metrics. OTel's Prometheus exporter
      // filters out counters whose only observations are .add(0), so
      // every cycle must emit at least one nonzero sample.
      coldStoreArchiveCyclesTotal().add(1, { db: this.db, result: 'disabled' });
      return summary;
    }

    if (this.adapters.size === 0) {
      // Framework alive but no adapters registered. Bump the cycles
      // counter so /metrics carries proof that the subsystem ran.
      coldStoreArchiveCyclesTotal().add(1, { db: this.db, result: 'no_tables' });
      summary.skipped.no_tables += 1;
      this.log('info', 'cold-store cycle: no adapters registered', {
        db: this.db,
        instanceId: this.instanceId,
        durationMs: Date.now() - start,
      });
      return summary;
    }

    const tableFilter = opts?.tableFilter;
    if (tableFilter && !this.adapters.has(tableFilter)) {
      throw new Error(
        `runArchiveCycle: tableFilter='${tableFilter}' has no registered adapter on db=${this.db} (registered: ${
          [...this.adapters.keys()].join(', ') || '(none)'
        })`,
      );
    }

    for (const adapter of this.adapters.values()) {
      if (tableFilter && adapter.table !== tableFilter) continue;
      await this.processAdapter(adapter, summary);
      summary.tablesProcessed += 1;
    }

    const cycleResult =
      summary.rowsFailed > 0 ? 'failure' : summary.chunksWritten > 0 ? 'success' : 'no_tables';
    coldStoreArchiveCyclesTotal().add(1, { db: this.db, result: cycleResult });
    this.log('info', 'cold-store cycle complete', {
      db: this.db,
      instanceId: this.instanceId,
      durationMs: Date.now() - start,
      summary,
    });
    return summary;
  }

  private async processAdapter(
    adapter: TableAdapter<unknown>,
    summary: ArchiveCycleSummary,
  ): Promise<void> {
    if (!adapter.config.enabled) {
      summary.skipped.disabled += 1;
      return;
    }

    const warmCutoff = new Date(Date.now() - adapter.config.warmTtlDays * 86_400_000);
    let rowsThisCycle = 0;

    for await (const { tenantId, partitionDate } of adapter.listEligiblePartitions({
      warmCutoff,
    })) {
      if (rowsThisCycle >= adapter.config.maxRowsPerCycle) {
        this.log('info', 'cold-store: per-cycle row cap reached; yielding', {
          db: this.db,
          table: adapter.table,
          rowsThisCycle,
        });
        break;
      }

      const warmBytes = await adapter.countTenantWarmBytes({ tenantId, warmCutoff });
      if (warmBytes < adapter.config.minWarmTenantBytes) {
        summary.skipped.min_warm += 1;
        coldStoreArchiveRowsTotal().add(0, {
          db: this.db,
          table: adapter.table,
          result: 'skipped_min_warm',
        });
        continue;
      }

      const lockResult = await adapter.withPartitionLock({ tenantId, partitionDate }, async () => {
        return this.archivePartition(adapter, tenantId, partitionDate, summary);
      });
      if (lockResult === null) {
        this.log('info', 'cold-store: another archiver holds the partition lock; skipping', {
          db: this.db,
          table: adapter.table,
          tenantId,
          partitionDate,
        });
        continue;
      }
      rowsThisCycle += lockResult.rowsArchived;
    }
  }

  /**
   * Archive one (tenant, partitionDate).
   *
   * - Adapters WITHOUT `coldTtlDays`: legacy single-chunk path. Writes one
   *   chunk per partition at the day-prefix root with a v1 manifest. The
   *   GC sweep treats v1 chunks as `'forever'`.
   * - Adapters WITH `coldTtlDays`: Phase 2 per-bucket path. Buffers all
   *   eligible rows, groups by `coldDaysToBucket(coldTtlDays(row))`,
   *   then emits one chunk per non-empty bucket under the bucket
   *   subprefix with a v2 manifest carrying `bucket` + `maxColdDays`.
   *
   * In both paths the caller holds the advisory lock for the
   * partition. Returns the total row count archived across all chunks
   * so the outer loop can honor `maxRowsPerCycle`.
   */
  private async archivePartition(
    adapter: TableAdapter<unknown>,
    tenantId: string,
    partitionDate: string,
    summary: ArchiveCycleSummary,
  ): Promise<{ rowsArchived: number }> {
    if (adapter.coldTtlDays) {
      return this.archivePartitionBucketed(adapter, tenantId, partitionDate, summary);
    }
    return this.archivePartitionLegacy(adapter, tenantId, partitionDate, summary);
  }

  /**
   * Legacy single-chunk-per-partition flow. Adapters that do not
   * implement `coldTtlDays` get a v1 manifest at the day-prefix root.
   */
  private async archivePartitionLegacy(
    adapter: TableAdapter<unknown>,
    tenantId: string,
    partitionDate: string,
    summary: ArchiveCycleSummary,
  ): Promise<{ rowsArchived: number }> {
    const partitionStart = Date.now();
    const label = { db: this.db, table: adapter.table };
    let encoded: EncodedChunk;
    try {
      encoded = await encodeChunk({
        rows: adapter.selectEligible({
          tenantId,
          partitionDate,
          limit: adapter.config.maxRowsPerCycle,
        }),
        encodeRow: adapter.encodeRow.bind(adapter),
        rowId: adapter.rowId.bind(adapter),
        rowTimestamp: adapter.rowTimestamp.bind(adapter),
        replayLookupKey: adapter.replayLookupKey?.bind(adapter),
      });
    } catch (err) {
      if (err instanceof Error && /empty row stream/.test(err.message)) {
        // Race: discovery saw rows, select saw none. Partition got
        // drained between the two queries. Not an error.
        summary.skipped.min_chunk += 1;
        return { rowsArchived: 0 };
      }
      throw err;
    }

    if (encoded.gzipByteCount < adapter.config.minChunkBytes) {
      summary.skipped.min_chunk += 1;
      coldStoreArchiveRowsTotal().add(0, { ...label, result: 'skipped_min_chunk' });
      return { rowsArchived: 0 };
    }

    return this.writeChunk(adapter, {
      tenantId,
      partitionDate,
      encoded,
      partitionStart,
      summary,
      // Legacy v1: no bucket segment, no v2 manifest fields.
      bucket: undefined,
      maxColdDays: undefined,
    });
  }

  /**
   * Phase 2 per-bucket flow. Buffers all eligible rows, groups by
   * `coldDaysToBucket(coldTtlDays(row))`, then emits one chunk per
   * non-empty bucket.
   */
  private async archivePartitionBucketed(
    adapter: TableAdapter<unknown>,
    tenantId: string,
    partitionDate: string,
    summary: ArchiveCycleSummary,
  ): Promise<{ rowsArchived: number }> {
    const label = { db: this.db, table: adapter.table };
    const coldTtlDays = adapter.coldTtlDays!.bind(adapter);

    // Buffer up to `maxRowsPerCycle` rows so we can re-stream each
    // bucket subset through `encodeChunk`. Memory stays bounded by the
    // existing per-cycle row cap.
    type BucketRows = {
      rows: unknown[];
      maxColdDays: ColdRetention;
    };
    const buckets = new Map<string, BucketRows>();
    let bufferedRows = 0;
    for await (const row of adapter.selectEligible({
      tenantId,
      partitionDate,
      limit: adapter.config.maxRowsPerCycle,
    })) {
      const ttl = coldTtlDays(row);
      const bucket = coldDaysToBucket(ttl);
      const entry = buckets.get(bucket);
      if (entry) {
        entry.rows.push(row);
        if (isLongerColdRetention(ttl, entry.maxColdDays)) entry.maxColdDays = ttl;
      } else {
        buckets.set(bucket, { rows: [row], maxColdDays: ttl });
      }
      bufferedRows += 1;
    }

    if (bufferedRows === 0) {
      // Race: discovery saw rows, select saw none.
      summary.skipped.min_chunk += 1;
      return { rowsArchived: 0 };
    }

    let totalArchived = 0;
    for (const [bucket, { rows, maxColdDays }] of buckets) {
      const partitionStart = Date.now();
      let encoded: EncodedChunk;
      try {
        encoded = await encodeChunk({
          rows: arrayToAsync(rows),
          encodeRow: adapter.encodeRow.bind(adapter) as (r: unknown) => string,
          rowId: adapter.rowId.bind(adapter) as (r: unknown) => string | number,
          rowTimestamp: adapter.rowTimestamp.bind(adapter) as (r: unknown) => Date | string,
          replayLookupKey: adapter.replayLookupKey?.bind(adapter) as
            | ((r: unknown) => string | undefined)
            | undefined,
        });
      } catch (err) {
        // arrayToAsync produces a non-empty stream by construction (we
        // only enter the loop with bucket.rows.length > 0), so an
        // 'empty row stream' here would be a framework bug. Re-raise.
        throw err;
      }

      if (encoded.gzipByteCount < adapter.config.minChunkBytes) {
        // Bucket too small to meet the minChunkBytes floor — skip this
        // bucket but continue with the others. Next cycle will retry
        // (rows still in PG since markArchivedAndDelete hasn't run for
        // this bucket yet).
        summary.skipped.min_chunk += 1;
        coldStoreArchiveRowsTotal().add(0, { ...label, result: 'skipped_min_chunk' });
        this.log('info', 'cold-store: bucket below minChunkBytes; skipping this cycle', {
          ...label,
          tenantId,
          partitionDate,
          bucket,
          rowCount: rows.length,
          gzipByteCount: encoded.gzipByteCount,
          minChunkBytes: adapter.config.minChunkBytes,
        });
        continue;
      }

      const result = await this.writeChunk(adapter, {
        tenantId,
        partitionDate,
        encoded,
        partitionStart,
        summary,
        bucket,
        maxColdDays,
      });
      totalArchived += result.rowsArchived;
    }
    return { rowsArchived: totalArchived };
  }

  /**
   * Common chunk-write flow: PUT data, verify, PUT manifest, transactional
   * mark-archived-and-delete on the adapter, increment metrics.
   *
   * Shared by `archivePartitionLegacy` (v1 manifests) and
   * `archivePartitionBucketed` (v2 manifests with bucket + maxColdDays).
   */
  private async writeChunk(
    adapter: TableAdapter<unknown>,
    args: {
      tenantId: string;
      partitionDate: string;
      encoded: EncodedChunk;
      partitionStart: number;
      summary: ArchiveCycleSummary;
      bucket: string | undefined;
      maxColdDays: ColdRetention | undefined;
    },
  ): Promise<{ rowsArchived: number }> {
    const { tenantId, partitionDate, encoded, partitionStart, summary, bucket, maxColdDays } = args;
    const label = { db: this.db, table: adapter.table };

    // Invariant: bucket and maxColdDays travel together. Either both are set
    // (Phase 2 per-bucket path → v2 manifest) or both are undefined (legacy
    // single-chunk path → v1 manifest). A misalignment would write a chunk
    // under a bucket subprefix with a v1 manifest (or vice versa), creating
    // data the read-through can't find. Surface it loudly.
    if ((bucket === undefined) !== (maxColdDays === undefined)) {
      throw new Error(
        `cold-store writeChunk: bucket and maxColdDays must both be set or both undefined; got bucket=${JSON.stringify(bucket)} maxColdDays=${JSON.stringify(maxColdDays)}`,
      );
    }

    const chunkId = computeChunkId({
      db: this.db,
      table: adapter.table,
      tenantId,
      partitionDate,
      minRowId: encoded.minRowId,
      maxRowId: encoded.maxRowId,
    });
    const keyArgs = {
      prefix: this.config.storage.prefix,
      db: this.db,
      table: adapter.table,
      tenantId,
      partitionDate,
      chunkId,
      bucket,
    };
    const dataKey = chunkObjectKey({ ...keyArgs, kind: 'data' as const });
    const manifestKey = chunkObjectKey({ ...keyArgs, kind: 'manifest' as const });

    try {
      await this.putChunkData(dataKey, encoded.data, encoded.contentHash);
      await this.verifyChunkData(dataKey, encoded.contentHash, adapter.table);

      const manifest: ChunkManifest =
        bucket !== undefined && maxColdDays !== undefined
          ? {
              schemaVersion: 2,
              db: this.db,
              table: adapter.table,
              tenantId,
              partitionDate,
              rowCount: encoded.rowCount,
              byteCount: encoded.byteCount,
              gzipByteCount: encoded.gzipByteCount,
              minTimestamp: encoded.minTimestamp,
              maxTimestamp: encoded.maxTimestamp,
              minRowId: encoded.minRowId,
              maxRowId: encoded.maxRowId,
              contentHash: encoded.contentHash,
              chunkId,
              createdAt: new Date().toISOString(),
              archiverInstanceId: this.instanceId,
              replayLookupKeys: encoded.replayLookupKeys,
              bucket,
              maxColdDays,
            }
          : {
              schemaVersion: 1,
              db: this.db,
              table: adapter.table,
              tenantId,
              partitionDate,
              rowCount: encoded.rowCount,
              byteCount: encoded.byteCount,
              gzipByteCount: encoded.gzipByteCount,
              minTimestamp: encoded.minTimestamp,
              maxTimestamp: encoded.maxTimestamp,
              minRowId: encoded.minRowId,
              maxRowId: encoded.maxRowId,
              contentHash: encoded.contentHash,
              chunkId,
              createdAt: new Date().toISOString(),
              archiverInstanceId: this.instanceId,
              replayLookupKeys: encoded.replayLookupKeys,
            };
      await this.putManifest(manifestKey, manifest);

      await adapter.markArchivedAndDelete({
        rowIds: encoded.rowIds,
        chunkMeta: {
          chunkId,
          tenantId,
          partitionDate,
          rowCount: encoded.rowCount,
          byteCount: encoded.byteCount,
          gzipByteCount: encoded.gzipByteCount,
          objectKey: dataKey,
          bucket,
          maxColdDays,
        },
      });

      summary.chunksWritten += 1;
      summary.rowsArchived += encoded.rowCount;
      coldStoreArchiveRowsTotal().add(encoded.rowCount, { ...label, result: 'success' });
      coldStoreArchiveBytesTotal().add(encoded.byteCount, { ...label, kind: 'raw' });
      coldStoreArchiveBytesTotal().add(encoded.gzipByteCount, { ...label, kind: 'gzipped' });
      coldStoreArchiveDurationSeconds().record((Date.now() - partitionStart) / 1000, label);

      this.log('info', 'cold-store chunk archived', {
        event: 'chunk_archived',
        ...label,
        tenantId,
        partitionDate,
        chunkId,
        bucket,
        maxColdDays,
        rowCount: encoded.rowCount,
        byteCount: encoded.byteCount,
        gzipByteCount: encoded.gzipByteCount,
        durationMs: Date.now() - partitionStart,
      });
      return { rowsArchived: encoded.rowCount };
    } catch (err) {
      summary.rowsFailed += encoded.rowCount;
      coldStoreArchiveRowsTotal().add(encoded.rowCount, { ...label, result: 'failure' });
      coldStoreArchiveDurationSeconds().record((Date.now() - partitionStart) / 1000, label);
      this.log('error', 'cold-store chunk archive failed', {
        ...label,
        tenantId,
        partitionDate,
        bucket,
        chunkId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Do NOT re-throw: one chunk's failure should not abort the
      // whole partition (other buckets may still succeed) or cycle.
      // Next cycle retries the same chunk (same chunkId, idempotent
      // PUT).
      return { rowsArchived: 0 };
    }
  }

  private async putChunkData(key: string, body: Buffer, contentHash: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.storage.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/gzip',
        Metadata: { [CONTENT_HASH_META]: contentHash },
      }),
    );
  }

  private async verifyChunkData(
    key: string,
    expectedHash: string,
    table: string,
    attempt = 0,
  ): Promise<void> {
    const head = await this.s3.send(
      new HeadObjectCommand({
        Bucket: this.config.storage.bucket,
        Key: key,
      }),
    );
    const gotHash = head.Metadata?.[CONTENT_HASH_META];
    if (gotHash === expectedHash) return;

    coldStoreVerifyFailuresTotal().add(1, { db: this.db, table });
    if (attempt >= 2) {
      throw new Error(
        `cold-store: HeadObject content-hash mismatch for ${key} after 3 attempts (got ${gotHash ?? '<missing>'}, expected ${expectedHash})`,
      );
    }
    this.log('warn', 'cold-store: verify hash mismatch; retrying', {
      db: this.db,
      table,
      key,
      attempt,
    });
    return this.verifyChunkData(key, expectedHash, table, attempt + 1);
  }

  private async putManifest(key: string, manifest: ChunkManifest): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.storage.bucket,
        Key: key,
        Body: Buffer.from(serializeManifest(manifest), 'utf-8'),
        ContentType: 'application/json',
      }),
    );
  }

  // ── Read-through ───────────────────────────────────────────────────

  async *fetchRange<TRow>(args: ColdStoreFetchRangeArgs<TRow>): AsyncIterable<TRow> {
    if (!this.config.enabled) return;

    const adapter = this.adapters.get(args.table);
    const decodeLine =
      args.decode ??
      (adapter
        ? (line: string) => adapter.decodeRow(line) as TRow
        : (line: string) => JSON.parse(line) as TRow);
    const rowTimestamp = adapter
      ? (row: TRow) => this.toDate((adapter.rowTimestamp as (r: unknown) => Date | string)(row))
      : null;

    const manifests = await this.listRelevantManifests({
      db: args.db,
      table: args.table,
      tenantId: args.tenantId,
      fromTs: args.fromTs,
      toTs: args.toTs,
    });

    const label = { db: args.db, table: args.table };
    for (const manifest of manifests) {
      // v2 manifests live under a bucket subprefix (`<day>/<bucket>/<chunk>`);
      // v1 manifests live at the day root (`<day>/<chunk>`). The schemaVersion
      // gate keeps the v1 read-back compatible.
      const dataKey = chunkObjectKey({
        prefix: this.config.storage.prefix,
        db: args.db,
        table: args.table,
        tenantId: args.tenantId,
        partitionDate: manifest.partitionDate,
        chunkId: manifest.chunkId,
        kind: 'data',
        bucket: manifest.schemaVersion === 2 ? manifest.bucket : undefined,
      });
      const fetchStart = Date.now();
      const gzipped = await this.getChunkData(dataKey, manifest.contentHash);
      coldStoreRehydrateDurationSeconds().record((Date.now() - fetchStart) / 1000, label);

      for await (const row of decodeChunk<TRow>({ gzipped, decodeLine })) {
        if (rowTimestamp) {
          const ts = rowTimestamp(row);
          if (ts < args.fromTs || ts >= args.toTs) continue;
        }
        yield row;
      }
    }
  }

  async hasRange(args: Omit<ColdStoreFetchRangeArgs<unknown>, 'decode'>): Promise<boolean> {
    if (!this.config.enabled) return false;
    const manifests = await this.listRelevantManifests(args);
    return manifests.length > 0;
  }

  async countRange(args: Omit<ColdStoreFetchRangeArgs<unknown>, 'decode'>): Promise<number> {
    if (!this.config.enabled) return 0;
    const manifests = await this.listRelevantManifests(args);
    let total = 0;
    for (const m of manifests) total += m.rowCount;
    return total;
  }

  /**
   * Resolve all manifest sidecars whose time-range overlaps
   * [fromTs, toTs). Uses one LIST walk under the tenant prefix, then
   * GETs each `.manifest.json`.
   */
  private async listRelevantManifests(args: {
    db: DbKind;
    table: string;
    tenantId: string;
    fromTs: Date;
    toTs: Date;
  }): Promise<ChunkManifest[]> {
    const tenantPrefix =
      tablePrefix({
        prefix: this.config.storage.prefix,
        db: args.db,
        table: args.table,
      }) + `/${encodeKeySegment(args.tenantId)}/`;

    const manifestKeys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const resp = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.config.storage.bucket,
          Prefix: tenantPrefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );
      for (const obj of resp.Contents ?? []) {
        if (obj.Key && obj.Key.endsWith('.manifest.json')) {
          manifestKeys.push(obj.Key);
        }
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    const manifests: ChunkManifest[] = [];
    for (const key of manifestKeys) {
      const m = await this.getManifest(key);
      const min = new Date(m.minTimestamp);
      const max = new Date(m.maxTimestamp);
      // Overlap test: [minTs, maxTs] ∩ [fromTs, toTs) ≠ ∅
      if (max < args.fromTs) continue;
      if (min >= args.toTs) continue;
      manifests.push(m);
    }
    manifests.sort((a, b) => (a.minTimestamp < b.minTimestamp ? -1 : 1));
    return manifests;
  }

  private async getManifest(key: string): Promise<ChunkManifest> {
    const resp = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.storage.bucket,
        Key: key,
      }),
    );
    if (!resp.Body) throw new Error(`cold-store: empty manifest body for ${key}`);
    const bytes = await resp.Body.transformToByteArray();
    return parseManifest(Buffer.from(bytes));
  }

  private async getChunkData(key: string, expectedHash: string): Promise<Buffer> {
    const label = { db: this.db, table: keyToTable(key) };
    const cached = this.chunkCache?.get(key);
    if (cached) {
      coldStoreRehydrateRequestsTotal().add(1, { ...label, cache_outcome: 'hit' });
      return cached;
    }

    coldStoreRehydrateRequestsTotal().add(1, { ...label, cache_outcome: 'miss' });
    const resp = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.storage.bucket,
        Key: key,
      }),
    );
    if (!resp.Body) throw new Error(`cold-store: empty chunk body for ${key}`);
    const bytes = await resp.Body.transformToByteArray();
    const body = Buffer.from(bytes);
    coldStoreRehydrateBytesTotal().add(body.byteLength, label);

    const got = sha256(body);
    if (got !== expectedHash) {
      coldStoreVerifyFailuresTotal().add(1, label);
      throw new Error(
        `cold-store: chunk content-hash mismatch for ${key} (got ${got}, expected ${expectedHash})`,
      );
    }
    this.chunkCache?.set(key, body);
    return body;
  }

  // ── Replay-into-PG (Phase F) ───────────────────────────────────────

  /**
   * Promote every row in a chunk back into PG. The adapter owns the
   * actual INSERT + audit + chunk-counter decrement (transactional).
   *
   * Throws when:
   *  - the cold store is disabled
   *  - the adapter is unregistered or doesn't implement `replayInsert`
   *  - the manifest is missing
   *  - the data file's sha256 doesn't match the manifest's
   *    `contentHash` (refuse to replay a tampered chunk)
   *
   * Idempotent on re-run: the adapter's `ON CONFLICT DO NOTHING`
   * collapses the second pass to `inserted=0, skipped=rowCount`.
   */
  async replayChunk(args: ColdStoreReplayChunkArgs): Promise<ColdStoreReplayResult> {
    if (!this.config.enabled) {
      throw new Error('cold-store: replayChunk called while cold-store is disabled');
    }
    const adapter = this.adapters.get(args.table);
    if (!adapter) {
      throw new Error(
        `cold-store: replay-chunk requires a registered adapter for table '${args.table}' on db=${this.db}`,
      );
    }
    if (!adapter.replayInsert) {
      throw new Error(
        `cold-store: replay-into-pg not supported for table '${args.table}' (adapter has no replayInsert)`,
      );
    }
    if (adapter.db !== args.db) {
      throw new Error(
        `cold-store: replayChunk db=${args.db} does not match adapter db=${adapter.db}`,
      );
    }

    const start = Date.now();
    const label = { db: args.db, table: args.table };
    try {
      // Discover the manifest key by listing under the day prefix: v1
      // chunks sit at the day-prefix root, v2 chunks sit under a
      // `<bucket>` subprefix, and the caller has no reason to know
      // which layout was used at archive time. chunkId is unique within
      // a (tenant, partitionDate), so the suffix match is exact.
      const dayPrefix = tenantDayPrefix({
        prefix: this.config.storage.prefix,
        db: args.db,
        table: args.table,
        tenantId: args.tenantId,
        partitionDate: args.partitionDate,
      });
      const dayKeys = await this.listObjectKeys(dayPrefix);
      const manifestSuffix = `/${args.chunkId}.manifest.json`;
      const manifestKey = dayKeys.find((k) => k.endsWith(manifestSuffix));
      if (!manifestKey) {
        throw new Error(
          `cold-store: replay-chunk ${args.chunkId} not found under ${dayPrefix} (db=${args.db} table=${args.table} tenantId=${args.tenantId} partitionDate=${args.partitionDate})`,
        );
      }
      const dataKey = manifestKey.replace(/\.manifest\.json$/, '.jsonl.gz');

      const [data, manifest] = await Promise.all([
        this.getObjectBody(dataKey),
        this.getManifest(manifestKey),
      ]);

      const got = sha256(data);
      if (got !== manifest.contentHash) {
        coldStoreVerifyFailuresTotal().add(1, label);
        throw new Error(
          `cold-store: replay-chunk ${args.chunkId} refused — contentHash mismatch (got ${got}, manifest ${manifest.contentHash})`,
        );
      }

      const rows: unknown[] = [];
      for await (const row of decodeChunk<unknown>({
        gzipped: data,
        decodeLine: (line: string) => adapter.decodeRow(line),
      })) {
        rows.push(row);
      }

      const chunkMeta: ChunkCommitMetadata = {
        chunkId: manifest.chunkId,
        tenantId: manifest.tenantId,
        partitionDate: manifest.partitionDate,
        rowCount: manifest.rowCount,
        byteCount: manifest.byteCount,
        gzipByteCount: manifest.gzipByteCount,
        objectKey: dataKey,
      };
      // Bind to the adapter so `this` inside `replayInsert` resolves to
      // the adapter instance — without this, the destructured callable
      // loses its receiver and crashes on `this.kdb`.
      const replayInsert = adapter.replayInsert.bind(adapter) as (rArgs: {
        rows: ReadonlyArray<unknown>;
        chunkMeta: ChunkCommitMetadata;
      }) => Promise<{ inserted: number; skipped: number }>;
      const result = await replayInsert({ rows, chunkMeta });

      coldStoreReplayRowsTotal().add(result.inserted, { ...label, result: 'success' });
      if (result.skipped > 0) {
        coldStoreReplayRowsTotal().add(result.skipped, {
          ...label,
          result: 'idempotent_skip',
        });
      }
      coldStoreReplayDurationSeconds().record((Date.now() - start) / 1000, label);

      this.log('info', 'cold-store chunk replayed', {
        event: 'chunk_replayed',
        ...label,
        tenantId: manifest.tenantId,
        partitionDate: manifest.partitionDate,
        chunkId: args.chunkId,
        rowsReplayed: result.inserted,
        rowsSkipped: result.skipped,
        durationMs: Date.now() - start,
      });

      return { inserted: result.inserted, skipped: result.skipped, chunkId: args.chunkId };
    } catch (err) {
      coldStoreReplayRowsTotal().add(0, { ...label, result: 'failure' });
      coldStoreReplayDurationSeconds().record((Date.now() - start) / 1000, label);
      this.log('error', 'cold-store chunk replay failed', {
        ...label,
        chunkId: args.chunkId,
        tenantId: args.tenantId,
        partitionDate: args.partitionDate,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Locate the chunk whose `[minRowId, maxRowId]` window covers
   * `rowId` and replay it. Scans manifests under the tenant prefix
   * (LIST is one round-trip; manifests are tiny). When several manifests
   * match (overlapping ranges from re-archives), the one with the
   * smallest range is preferred — it's the most recently re-archived
   * shard and therefore the one whose row contents are freshest.
   *
   * Returns `chunkId: null` when no manifest matches — the caller
   * decides whether that means "row never existed" (rerun → 404) or
   * "S3 outage" (rerun → 410 replayFailed). This method only fails
   * loudly on infrastructure errors (missing chunk after manifest
   * found, hash mismatch).
   */
  async replayRow(args: ColdStoreReplayRowArgs): Promise<ColdStoreReplayResult> {
    if (!this.config.enabled) {
      return { inserted: 0, skipped: 0, chunkId: null };
    }
    const tenantPrefix =
      tablePrefix({
        prefix: this.config.storage.prefix,
        db: args.db,
        table: args.table,
      }) + `/${encodeKeySegment(args.tenantId)}/`;

    const manifestKeys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const resp = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.config.storage.bucket,
          Prefix: tenantPrefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );
      for (const obj of resp.Contents ?? []) {
        if (obj.Key && obj.Key.endsWith('.manifest.json')) manifestKeys.push(obj.Key);
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);

    const wanted = String(args.rowId);
    let best: { manifest: ChunkManifest; rangeWidth: number } | null = null;
    let exact: ChunkManifest | null = null;
    for (const key of manifestKeys) {
      const m = await this.getManifest(key);
      // Phase F primary path: explicit natural-key lookup. Adapters that
      // populate `replayLookupKeys` (e.g. execution_runs storing run_id
      // UUIDs) make replayRow exact even when the chunk's `minRowId` /
      // `maxRowId` are an unrelated SERIAL `id` the caller doesn't know.
      if (m.replayLookupKeys && m.replayLookupKeys.includes(wanted)) {
        exact = m;
        break;
      }
      const lo = m.minRowId;
      const hi = m.maxRowId;
      if (compareIds(args.rowId, lo) < 0) continue;
      if (compareIds(args.rowId, hi) > 0) continue;
      const width = idDistance(lo, hi);
      if (best === null || width < best.rangeWidth) {
        best = { manifest: m, rangeWidth: width };
      }
    }

    const picked = exact ?? best?.manifest ?? null;
    if (!picked) return { inserted: 0, skipped: 0, chunkId: null };

    return this.replayChunk({
      db: args.db,
      table: args.table,
      tenantId: picked.tenantId,
      partitionDate: picked.partitionDate,
      chunkId: picked.chunkId,
    });
  }

  private toDate(v: Date | string): Date {
    return v instanceof Date ? v : new Date(v);
  }

  // ── Phase 2: cold-store purge sweep ────────────────────────────────

  /**
   * Subclass hook — query the per-DB `cold_store_chunks` index for
   * purge candidates. Concrete subclasses (PlatformColdStore /
   * OrchestratorColdStore) implement this with one Kysely SQL query
   * keyed off `archived_at + max_cold_days * INTERVAL '1 day' < now()`
   * and `max_cold_days != 'forever'`.
   *
   * Returning an empty array makes `purgeExpiredChunks` a no-op.
   * Default implementation returns `[]` so non-purge subclasses (or
   * test fixtures) can opt out trivially.
   */
  protected async listPurgeableChunks(_opts: {
    tableFilter?: string;
    bucketFilter?: string;
    limit: number;
  }): Promise<PurgeableChunk[]> {
    return [];
  }

  /**
   * Acquire a per-chunk advisory lock so concurrent sweeps can't
   * race on the same `DeleteObject` + `cold_store_chunks` row.
   *
   * Default implementation is a no-op (always succeeds). Subclasses
   * with a Kysely instance override to use `pg_try_advisory_lock` on
   * `hashtext('cold-store-purge|<db>|<table>|<chunkId>')` and release
   * inside `fn`'s `finally`. Returns `null` when another worker holds
   * the lock; returns the `fn` result on success.
   */
  protected async withPurgeLock<T>(
    _args: { table: string; chunkId: string },
    fn: () => Promise<T>,
  ): Promise<T | null> {
    return fn();
  }

  async purgeExpiredChunks(opts?: PurgeExpiredChunksOpts): Promise<PurgeExpiredChunksSummary> {
    const start = Date.now();
    if (!this.config.enabled) {
      return { results: [], bytesPurged: 0, chunksPurged: 0, durationMs: 0 };
    }

    const limit = opts?.limit ?? 1000;
    const dryRun = opts?.dryRun ?? false;
    const candidates = await this.listPurgeableChunks({
      tableFilter: opts?.tableFilter,
      bucketFilter: opts?.bucketFilter,
      limit,
    });

    const results: PurgeChunkResult[] = [];
    let bytesPurged = 0;
    let chunksPurged = 0;

    for (const c of candidates) {
      const baseResult = {
        table: c.table,
        tenantId: c.tenantId,
        chunkId: c.chunkId,
        bucket: c.bucket,
        gzipBytes: c.gzipBytes,
        rowCount: c.rowCount,
      };
      const label = { db: this.db, table: c.table };

      if (dryRun) {
        results.push({ ...baseResult, outcome: 'dry_run' });
        coldStorePurgeChunksTotal().add(1, { ...label, result: 'dry_run' });
        continue;
      }

      const adapter = this.adapters.get(c.table);
      if (!adapter) {
        results.push({
          ...baseResult,
          outcome: 'failure',
          error: `no adapter registered for table=${c.table}`,
        });
        coldStorePurgeChunksTotal().add(1, { ...label, result: 'failure' });
        continue;
      }
      if (!adapter.purgeChunkRecord) {
        results.push({
          ...baseResult,
          outcome: 'failure',
          error: `adapter ${c.table} does not implement purgeChunkRecord`,
        });
        coldStorePurgeChunksTotal().add(1, { ...label, result: 'failure' });
        continue;
      }

      const lockResult = await this.withPurgeLock(
        { table: c.table, chunkId: c.chunkId },
        async () => {
          // 1. Delete the data + manifest objects from S3. Both deletes
          //    are issued; if either fails we surface the error and
          //    leave the chunk-index row in place so the next sweep
          //    retries.
          const manifestKey = c.objectKey.replace(/\.jsonl\.gz$/, '.manifest.json');
          await this.s3.send(
            new DeleteObjectCommand({ Bucket: this.config.storage.bucket, Key: c.objectKey }),
          );
          await this.s3.send(
            new DeleteObjectCommand({ Bucket: this.config.storage.bucket, Key: manifestKey }),
          );
          // 2. Adapter cleans up PG: DELETE from cold_store_chunks +
          //    decrement rollup + write 'purge_chunk' audit row, all
          //    inside one transaction.
          await adapter.purgeChunkRecord!({
            tenantId: c.tenantId,
            chunkId: c.chunkId,
            gzipBytes: c.gzipBytes,
            rowCount: c.rowCount,
            bucket: c.bucket,
            maxColdDays: c.maxColdDays,
            objectKey: c.objectKey,
          });
          return true as const;
        },
      ).catch((err) => {
        results.push({
          ...baseResult,
          outcome: 'failure',
          error: err instanceof Error ? err.message : String(err),
        });
        coldStorePurgeChunksTotal().add(1, { ...label, result: 'failure' });
        return false as const;
      });

      if (lockResult === null) {
        results.push({ ...baseResult, outcome: 'skipped_locked' });
        coldStorePurgeChunksTotal().add(1, { ...label, result: 'skipped_locked' });
        continue;
      }
      if (lockResult === true) {
        results.push({ ...baseResult, outcome: 'purged' });
        bytesPurged += c.gzipBytes;
        chunksPurged += 1;
        coldStorePurgeChunksTotal().add(1, { ...label, result: 'purged' });
        coldStorePurgeBytesTotal().add(c.gzipBytes, label);
      }
    }

    coldStorePurgeDurationSeconds().record((Date.now() - start) / 1000, { db: this.db });

    const summary: PurgeExpiredChunksSummary = {
      results,
      bytesPurged,
      chunksPurged,
      durationMs: Date.now() - start,
    };

    this.log('info', 'cold-store purge sweep complete', {
      db: this.db,
      dryRun,
      candidates: candidates.length,
      chunksPurged,
      bytesPurged,
      durationMs: summary.durationMs,
    });

    return summary;
  }
}

function compareIds(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const as = String(a);
  const bs = String(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

function idDistance(lo: string | number, hi: string | number): number {
  if (typeof lo === 'number' && typeof hi === 'number') return Math.max(0, hi - lo);
  // String IDs: use length-difference + lexicographic offset as a stable
  // tie-breaker. We only need a "smaller window > larger window" order
  // for the best-match preference; exact distance doesn't matter. Clamp
  // to >= 0 so an inverted range (hi shorter than lo by lexicographic
  // accident, e.g. "10" < "9") doesn't produce a negative width that
  // always wins the `width < best.rangeWidth` comparison.
  const lenDelta = String(hi).length - String(lo).length;
  if (lenDelta !== 0) return Math.max(0, lenDelta);
  return String(hi) < String(lo) ? 0 : 1;
}

/**
 * Best-effort extraction of the table name from a chunk key of shape
 * `<prefix>/<db>/<table>/<tenant>/<YYYY>/<MM>/<DD>/<chunk>.ext` (v1) or
 * `<prefix>/<db>/<table>/<tenant>/<YYYY>/<MM>/<DD>/<bucket>/<chunk>.ext`
 * (v2 with bucket subprefix). Used for metric labels on the read-through
 * path; returns `'unknown'` if the key doesn't parse.
 */
function keyToTable(key: string): string {
  const parts = key.split('/');
  // Walk from the end: the year segment is always 4 digits. The table
  // sits two segments before. Walking back from `length - 4` covers
  // the v1 layout in O(1); the loop catches the v2 layout (one more
  // segment between year and chunk file) on the second iteration.
  for (let i = parts.length - 4; i >= 2; i--) {
    if (/^\d{4}$/.test(parts[i] ?? '')) {
      return parts[i - 2] ?? 'unknown';
    }
  }
  return 'unknown';
}

/**
 * Lift an in-memory array into an `AsyncIterable` so it can feed
 * `encodeChunk` (which expects a stream). Used by the per-bucket
 * archive flow to re-stream each bucket's row subset through the
 * existing single-stream encoder without further refactoring.
 */
async function* arrayToAsync<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const item of items) yield item;
}
