/**
 * BaseColdStore — the DB-agnostic framework class. Concrete subclasses
 * (`PlatformColdStore`, `OrchestratorColdStore`) register their own adapters.
 *
 * `fetchRange` / `hasRange` / `countRange` resolve manifests via
 * `ListObjectsV2` and GET overlapping chunks through an in-process LRU.
 *
 * ## Advisory-lock namespace
 *
 * Every framework advisory lock keys on `hashtext('cold-store|...')`. The
 * `cold-store|` prefix is reserved: do NOT reuse it in pipeline or engine code.
 *
 * ## S3 bucket versioning caveat
 *
 * With bucket versioning ON (the recommended default), a retried chunk PUT
 * adds a new version at the same key. Reconciliation (the `reconcile` CLI)
 * MUST use `ListObjectVersions`, not `ListObjects`, to find orphans. The live
 * read-through uses `ListObjectsV2`: it reads only each manifest's current
 * version.
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
import { ChunkLru } from './lru.js';
import { parseManifest, serializeManifest } from './manifest.js';
import {
  coldStoreArchiveBytesTotal,
  ColdStoreCycleResult,
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
import { resolveTableConfig } from './config.js';
import type { ColdStoreConfig } from './config.js';
import type { ChunkCommitMetadata, TableAdapter } from './table-adapter.js';
import type { ArchiveCycleSummary, ChunkManifest, ColdRetention } from './types.js';

const CONTENT_HASH_META = 'content-hash';

/**
 * Bound on the S3 GETs one read-through keeps in flight. Serial GETs (one
 * manifest + one data GET per chunk) cost 34 s for 262 chunks, past the
 * 30 s `kici-admin access-log list` client timeout.
 */
const READ_THROUGH_CONCURRENCY = 16;

/**
 * Manifest cache budget. A manifest is immutable (its chunk is
 * content-addressed), so caching it for the process lifetime is safe; at
 * ~600 bytes each this holds over ten thousand.
 */
const MANIFEST_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * Run `fn` over `items` with at most `limit` calls in flight, preserving
 * the input order in the result.
 */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** UTC calendar day of an instant as `YYYY-MM-DD`. */
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface ColdStoreFetchRangeArgs<TRow> {
  db: DbKind;
  table: string;
  tenantId: string;
  fromTs: Date;
  /**
   * Exclusive upper bound; defaults to `warmCutoff(table)`. Pass one only
   * when the caller owns the range (e.g. a user-supplied time filter).
   */
  toTs?: Date;
  decode?: (line: string) => TRow;
  /**
   * Row order by partition timestamp, default `'asc'`. `'desc'` lets a
   * newest-first paginated reader stop once its page is full instead of
   * reading every chunk. Order is global across chunks when the table has a
   * registered adapter (its `rowTimestamp` sorts); otherwise it is per-chunk
   * (chunks by manifest bounds, rows in archive order).
   */
  order?: 'asc' | 'desc';
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
  inserted: number;
  /** Rows whose unique key was already in PG (idempotent re-replay). */
  skipped: number;
  /** `null` when replayRow finds no match. */
  chunkId: string | null;
}

/**
 * Purge-sweep options. `tableFilter` serves `cold-store purge-now <table>`;
 * `bucketFilter` narrows to one bucket subprefix. `limit` caps chunks per
 * call so one sweep cannot OOM the orchestrator on a tenant with millions of
 * expired chunks. `dryRun=true` only lists candidates (the CLI default;
 * operators pass `--apply`).
 */
export interface PurgeExpiredChunksOpts {
  tableFilter?: string;
  bucketFilter?: string;
  limit?: number;
  dryRun?: boolean;
}

/**
 * One row per (chunk attempt, outcome), so callers can report without
 * re-querying the chunk index.
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
  /** Gzipped bytes purged from S3. */
  bytesPurged: number;
  /** Chunks with outcome `'purged'`. */
  chunksPurged: number;
  durationMs: number;
}

/** A `cold_store_chunks` row with a normalized `maxColdDays`. */
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
 * Public cold-store API. `replayChunk` / `replayRow` serve the
 * rerun-from-archive flow.
 */
export interface ColdStore {
  /**
   * The table's warm/cold boundary, `now − warmTtlDays`, resolved from the
   * SAME config the archival writer uses (adapter defaults merged with any
   * `KICI_COLD_STORE_<TABLE>_WARM_TTL_DAYS` override). Older rows may be in
   * cold storage; newer rows are guaranteed PG-only.
   *
   * Readers MUST derive their cold-read upper bound from this, never a
   * literal. A reader value LARGER than the writer's gives an EARLIER cutoff
   * that silently skips manifests whose `min` is newer, so a read 404s on
   * data that exists in S3.
   *
   * `warmTtlDays <= 0` yields a cutoff at or after `now`: the widest, safe
   * window.
   */
  warmCutoff(table: string): Date;
  /** Stream archived rows that overlap [fromTs, toTs). */
  fetchRange<TRow>(args: ColdStoreFetchRangeArgs<TRow>): AsyncIterable<TRow>;
  hasRange(args: Omit<ColdStoreFetchRangeArgs<unknown>, 'decode'>): Promise<boolean>;
  countRange(args: Omit<ColdStoreFetchRangeArgs<unknown>, 'decode'>): Promise<number>;
  /**
   * Run one archive cycle over every adapter in registration order, or only
   * `tableFilter` (the `archive-now <table>` CLI flush).
   */
  runArchiveCycle(opts?: { tableFilter?: string }): Promise<ArchiveCycleSummary>;
  /**
   * Promote every row in a chunk back into PG in one transaction; re-runs are
   * idempotent via the adapter's `ON CONFLICT DO NOTHING`. Throws if the
   * adapter lacks `replayInsert`, the chunk is missing, or the contentHash
   * check fails.
   */
  replayChunk(args: ColdStoreReplayChunkArgs): Promise<ColdStoreReplayResult>;
  /**
   * Find the chunk holding `rowId` by manifest `minRowId`/`maxRowId` bounds
   * and replay it. `chunkId: null` means no manifest matches: the row does
   * not exist anywhere.
   */
  replayRow(args: ColdStoreReplayRowArgs): Promise<ColdStoreReplayResult>;
  /**
   * Purge `cold_store_chunks` rows where
   * `now() > archived_at + max_cold_days * INTERVAL '1 day'` AND
   * `max_cold_days != 'forever'`. For each:
   *   1. Take a per-chunk advisory lock so concurrent sweeps cannot
   *      double-delete.
   *   2. `DeleteObject` the data and manifest keys.
   *   3. `adapter.purgeChunkRecord(...)` transactionally deletes the index
   *      row, decrements the rollup and writes a `purge_chunk` audit row.
   *
   * `dryRun=true` (CLI default) skips steps 2–3 and only returns candidates.
   * Production scheduled sweeps pass `dryRun=false`.
   */
  purgeExpiredChunks(opts?: PurgeExpiredChunksOpts): Promise<PurgeExpiredChunksSummary>;
}

export interface BaseColdStoreDeps {
  db: DbKind;
  config: ColdStoreConfig;
  instanceId: string;
  /** Caller-supplied logger, so this module does not pull in the shared logger. */
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** May be shared across consumers. */
  chunkCache?: ChunkLru<string, Buffer>;
  /** Defaults to `createS3Client(config.storage)`; tests pass a mock. */
  s3Client?: S3Client;
}

export abstract class BaseColdStore implements ColdStore {
  protected readonly db: DbKind;
  protected readonly config: ColdStoreConfig;
  protected readonly instanceId: string;
  protected readonly log: BaseColdStoreDeps['log'];
  protected readonly chunkCache: ChunkLru<string, Buffer> | undefined;
  private readonly manifestCache = new ChunkLru<string, ChunkManifest>({
    maxBytes: MANIFEST_CACHE_BYTES,
    sizeOf: (m) => JSON.stringify(m).length,
  });
  protected readonly s3: S3Client;
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

  /** Subclasses call this from their constructor. */
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
   * S3 primitives for admin CLI inspection / reconciliation, so the CLI needs
   * no direct `@aws-sdk/client-s3` dependency. Not for hot-path use.
   */
  get bucket(): string {
    return this.config.storage.bucket;
  }
  get storagePrefix(): string {
    return this.config.storage.prefix;
  }

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

  async getObjectBody(key: string): Promise<Buffer> {
    const resp = await this.s3.send(
      new GetObjectCommand({ Bucket: this.config.storage.bucket, Key: key }),
    );
    if (!resp.Body) throw new Error(`cold-store: empty body for ${key}`);
    const bytes = await resp.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async putManifestObject(key: string, manifest: ChunkManifest): Promise<void> {
    return this.putManifest(key, manifest);
  }

  /**
   * For tenant-scoped sweeps (e.g. the post-`deleteOrgCascade` S3 cleanup)
   * over chunks the index already forgot. Does NOT touch `cold_store_chunks`;
   * a caller needing both follows `purgeExpiredChunks` (`withPurgeLock` +
   * `adapter.purgeChunkRecord`).
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
      // OTel's Prometheus exporter drops counters observed only via .add(0),
      // so every cycle emits one nonzero sample to keep the
      // `kici-cold-store` scope visible on /metrics.
      coldStoreArchiveCyclesTotal().add(1, {
        db: this.db,
        result: ColdStoreCycleResult.enum.disabled,
      });
      return summary;
    }

    if (this.adapters.size === 0) {
      // Bump anyway so /metrics proves the subsystem ran.
      coldStoreArchiveCyclesTotal().add(1, {
        db: this.db,
        result: ColdStoreCycleResult.enum.no_tables,
      });
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

    const cycleResult: ColdStoreCycleResult =
      summary.rowsFailed > 0
        ? ColdStoreCycleResult.enum.failure
        : summary.chunksWritten > 0
          ? ColdStoreCycleResult.enum.success
          : ColdStoreCycleResult.enum.no_tables;
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

    const warmCutoff = this.warmCutoff(adapter.table);
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
   * - Without `coldTtlDays`: one chunk per partition at the day-prefix root
   *   with a v1 manifest; the GC sweep treats v1 chunks as `'forever'`.
   * - With `coldTtlDays`: rows grouped by `coldDaysToBucket(coldTtlDays(row))`,
   *   one chunk per non-empty bucket under its subprefix, with a v2 manifest
   *   carrying `bucket` + `maxColdDays`.
   *
   * The caller holds the partition advisory lock. Returns the total rows
   * archived so the outer loop can honor `maxRowsPerCycle`.
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
    return this.archivePartitionSingleChunk(adapter, tenantId, partitionDate, summary);
  }

  private async archivePartitionSingleChunk(
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
        // Race: the partition drained between discovery and select. Not an error.
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
      bucket: undefined,
      maxColdDays: undefined,
    });
  }

  private async archivePartitionBucketed(
    adapter: TableAdapter<unknown>,
    tenantId: string,
    partitionDate: string,
    summary: ArchiveCycleSummary,
  ): Promise<{ rowsArchived: number }> {
    const label = { db: this.db, table: adapter.table };
    const coldTtlDays = adapter.coldTtlDays!.bind(adapter);

    // Buffer (bounded by `maxRowsPerCycle`) so each bucket subset can be
    // re-streamed through `encodeChunk`.
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
            ((r: unknown) => string | undefined) | undefined,
        });
      } catch (err) {
        // Every bucket is non-empty, so 'empty row stream' here is a framework bug.
        throw err;
      }

      if (encoded.gzipByteCount < adapter.config.minChunkBytes) {
        // Skip only this bucket; its rows stay in PG and the next cycle retries.
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
   * PUT data, verify, PUT manifest, then the adapter's transactional
   * mark-archived-and-delete. Shared by the v1 and v2 (bucketed) paths.
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

    // Invariant: bucket and maxColdDays are both set (v2) or both undefined
    // (v1). A mismatch writes a chunk the read-through cannot find.
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
      // Do NOT re-throw: one chunk must not abort the partition or cycle. The
      // next cycle retries it (same chunkId, idempotent PUT).
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

  warmCutoff(table: string): Date {
    const cfg = this.adapters.get(table)?.config ?? resolveTableConfig(this.config.tables[table]);
    return new Date(Date.now() - cfg.warmTtlDays * 86_400_000);
  }

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

    const toTs = args.toTs ?? this.warmCutoff(args.table);
    const order = args.order ?? 'asc';

    const manifests = await this.listRelevantManifests({
      db: args.db,
      table: args.table,
      tenantId: args.tenantId,
      fromTs: args.fromTs,
      toTs,
    });

    // A chunk holds only its own partition day's rows (`selectEligible` is
    // day-bounded), so days never interleave: sorting within each day yields
    // a globally ordered stream, letting a newest-first reader stop early.
    const days = new Map<string, ChunkManifest[]>();
    for (const m of manifests) {
      const list = days.get(m.partitionDate);
      if (list) list.push(m);
      else days.set(m.partitionDate, [m]);
    }
    const dayOrder = [...days.keys()].sort();
    if (order === 'desc') dayOrder.reverse();

    const label = { db: args.db, table: args.table };
    const loadChunk = async (manifest: ChunkManifest): Promise<TRow[]> => {
      // v2: `<day>/<bucket>/<chunk>`; v1: `<day>/<chunk>`.
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

      const rows: TRow[] = [];
      for await (const row of decodeChunk<TRow>({ gzipped, decodeLine })) {
        if (rowTimestamp) {
          const ts = rowTimestamp(row);
          if (ts < args.fromTs || ts >= toTs) continue;
        }
        rows.push(row);
      }
      return rows;
    };
    const loadDay = async (day: string): Promise<TRow[]> => {
      const dayManifests = days.get(day) ?? [];
      if (order === 'desc') dayManifests.reverse();
      const perChunk = await mapConcurrent(dayManifests, READ_THROUGH_CONCURRENCY, loadChunk);
      const rows = perChunk.flat();
      if (rowTimestamp) {
        const sign = order === 'desc' ? -1 : 1;
        rows.sort((a, b) => sign * (rowTimestamp(a).getTime() - rowTimestamp(b).getTime()));
      }
      return rows;
    };

    // Prefetch a bounded window of days so single-chunk days do not cost one
    // serial round trip each. If the consumer stops early, the `finally`
    // keeps a late rejection from going unhandled.
    const pending: Array<Promise<TRow[]>> = [];
    let nextDay = 0;
    const fill = (): void => {
      while (pending.length < READ_THROUGH_CONCURRENCY && nextDay < dayOrder.length) {
        pending.push(loadDay(dayOrder[nextDay++]));
      }
    };
    try {
      fill();
      while (pending.length > 0) {
        const rows = await pending.shift()!;
        fill();
        for (const row of rows) yield row;
      }
    } finally {
      for (const p of pending) p.catch(() => undefined);
    }
  }

  async hasRange(args: Omit<ColdStoreFetchRangeArgs<unknown>, 'decode'>): Promise<boolean> {
    if (!this.config.enabled) return false;
    const manifests = await this.listRelevantManifests({
      ...args,
      toTs: args.toTs ?? this.warmCutoff(args.table),
    });
    return manifests.length > 0;
  }

  async countRange(args: Omit<ColdStoreFetchRangeArgs<unknown>, 'decode'>): Promise<number> {
    if (!this.config.enabled) return 0;
    const manifests = await this.listRelevantManifests({
      ...args,
      toTs: args.toTs ?? this.warmCutoff(args.table),
    });
    let total = 0;
    for (const m of manifests) total += m.rowCount;
    return total;
  }

  /** Manifests overlapping [fromTs, toTs): one LIST walk under the tenant prefix, then GETs. */
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

    // `<tenant>/<YYYY>/<MM>/<DD>/` names a UTC day, so a manifest of a day
    // outside [fromTs, toTs) is never fetched. Keys with no day segment fall
    // through to the manifest test.
    const fromDay = utcDay(args.fromTs);
    const toDayInclusive = utcDay(new Date(args.toTs.getTime() - 1));
    const candidateKeys =
      toDayInclusive < fromDay
        ? []
        : manifestKeys.filter((key) => {
            const m = /^(\d{4})\/(\d{2})\/(\d{2})\//.exec(key.slice(tenantPrefix.length));
            if (!m) return true;
            const day = `${m[1]}-${m[2]}-${m[3]}`;
            return day >= fromDay && day <= toDayInclusive;
          });

    const fetched = await mapConcurrent(candidateKeys, READ_THROUGH_CONCURRENCY, (key) =>
      this.getManifestCached(key),
    );
    const manifests: ChunkManifest[] = [];
    for (const m of fetched) {
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

  /**
   * Read-through only: the archiver and reconcile paths must see the object
   * as it is in S3 now, not as this process last saw it.
   */
  private async getManifestCached(key: string): Promise<ChunkManifest> {
    const cached = this.manifestCache.get(key);
    if (cached) return cached;
    const m = await this.getManifest(key);
    this.manifestCache.set(key, m);
    return m;
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

  // ── Replay-into-PG ─────────────────────────────────────────────────

  /**
   * The adapter owns the transactional INSERT + audit + chunk-counter
   * decrement. Throws when the cold store is disabled, the adapter is
   * unregistered or lacks `replayInsert`, the manifest is missing, or the
   * data sha256 differs from the manifest `contentHash` (a tampered chunk).
   * A re-run yields `inserted=0, skipped=rowCount` via `ON CONFLICT DO NOTHING`.
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
      // List the day prefix: the caller does not know whether the chunk is v1
      // (day root) or v2 (`<bucket>` subprefix). chunkId is unique per
      // (tenant, partitionDate), so the suffix match is exact.
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
      // Unbound, the callable loses its receiver and crashes on `this.kdb`.
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
   * Scans manifests under the tenant prefix (one LIST; manifests are tiny).
   * When re-archives leave overlapping ranges, the smallest range wins: it is
   * the most recently re-archived shard, so its rows are freshest.
   *
   * `chunkId: null` (no match) lets the caller choose "row never existed"
   * (rerun → 404) or "S3 outage" (rerun → 410 replayFailed). It throws only on
   * infrastructure errors (chunk missing after its manifest, hash mismatch).
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
      // Natural-key lookup first: `replayLookupKeys` (e.g. execution_runs
      // run_id UUIDs) is exact even when `minRowId` / `maxRowId` are a SERIAL
      // `id` the caller does not know.
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

  // ── Cold-store purge sweep ─────────────────────────────────────────

  /**
   * Subclass hook: purge candidates from the per-DB `cold_store_chunks` index,
   * keyed off `archived_at + max_cold_days * INTERVAL '1 day' < now()` and
   * `max_cold_days != 'forever'`. The default `[]` makes `purgeExpiredChunks`
   * a no-op, so non-purge subclasses and test fixtures opt out.
   */
  protected async listPurgeableChunks(_opts: {
    tableFilter?: string;
    bucketFilter?: string;
    limit: number;
  }): Promise<PurgeableChunk[]> {
    return [];
  }

  /**
   * Per-chunk advisory lock so concurrent sweeps cannot race on one
   * `DeleteObject` + `cold_store_chunks` row. The default always succeeds;
   * subclasses with Kysely use `pg_try_advisory_lock` on
   * `hashtext('cold-store-purge|<db>|<table>|<chunkId>')`, released in `fn`'s
   * `finally`. Returns `null` when another worker holds the lock.
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
          // A failed delete keeps the chunk-index row, so the next sweep retries.
          const manifestKey = c.objectKey.replace(/\.jsonl\.gz$/, '.manifest.json');
          await this.s3.send(
            new DeleteObjectCommand({ Bucket: this.config.storage.bucket, Key: c.objectKey }),
          );
          await this.s3.send(
            new DeleteObjectCommand({ Bucket: this.config.storage.bucket, Key: manifestKey }),
          );
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
  // String IDs only need a stable smaller-window-first order, not a true
  // distance. Clamp to >= 0 so an inverted range (e.g. "10" < "9") cannot
  // yield a negative width that always wins `width < best.rangeWidth`.
  const lenDelta = String(hi).length - String(lo).length;
  if (lenDelta !== 0) return Math.max(0, lenDelta);
  return String(hi) < String(lo) ? 0 : 1;
}

/**
 * Best-effort table name (for metric labels) from
 * `<prefix>/<db>/<table>/<tenant>/<YYYY>/<MM>/<DD>[/<bucket>]/<chunk>.ext`;
 * `'unknown'` if the key does not parse.
 */
function keyToTable(key: string): string {
  const parts = key.split('/');
  // The 4-digit year sits two segments after the table. `length - 4` hits it
  // for v1; v2's extra bucket segment matches on the second iteration.
  for (let i = parts.length - 4; i >= 2; i--) {
    if (/^\d{4}$/.test(parts[i] ?? '')) {
      return parts[i - 2] ?? 'unknown';
    }
  }
  return 'unknown';
}

/** Feeds a bucket's buffered rows to the stream-only `encodeChunk`. */
async function* arrayToAsync<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const item of items) yield item;
}
