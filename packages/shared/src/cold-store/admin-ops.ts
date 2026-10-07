/**
 * The `cold-store` admin subcommands shared by `kici-admin` (orchestrator
 * database) and `kici-platform-admin` (Platform database).
 *
 * Each side passes a `ColdStoreAdminSide`: the `db` key segment its chunks
 * live under, the noun its errors name, the `archiverInstanceId` a rebuilt
 * manifest records, and a `build()` that opens its own Postgres pool and
 * cold store. Every op:
 *
 *   - builds a fresh store per invocation (the CLI holds no long-lived state)
 *     and closes it when done
 *   - reaches S3 only through public `BaseColdStore` helpers
 *   - prints results to stdout (JSON Lines for list-chunks, JSONL for
 *     peek-chunk, free-form for the others)
 *   - throws on failure (the caller maps it to an exit code)
 */
import { sha256 } from '@kici-dev/core';
import { isLongerColdRetention } from './bucket.js';
import { computeChunkId } from './chunk-id.js';
import { compareRowIds, decodeChunk } from './chunk-encoder.js';
import type { BaseColdStore } from './cold-store.js';
import {
  chunkObjectKey,
  encodeKeySegment,
  tablePrefix,
  tenantDayPrefix,
  type DbKind,
} from './key.js';
import { parseManifest } from './manifest.js';
import type { TableAdapter } from './table-adapter.js';
import type { ChunkManifest, ColdRetention } from './types.js';

export interface BuiltColdStore {
  store: Pick<
    BaseColdStore,
    | 'getAdapter'
    | 'listAdapters'
    | 'runArchiveCycle'
    | 'listObjectKeys'
    | 'getObjectBody'
    | 'putManifestObject'
    | 'replayChunk'
    | 'purgeExpiredChunks'
  >;
  prefix: string;
  enabled: boolean;
  close: () => Promise<void>;
}

export interface ColdStoreAdminSide {
  /** Key segment and manifest `db` of this side's chunks. */
  db: DbKind;
  /** Noun the unknown-adapter error names, e.g. `Platform`. */
  label: string;
  /** `archiverInstanceId` recorded on a manifest `reconcile` rebuilds. */
  reconcileInstanceId: string;
  build: (deps: { databaseUrl: string; instanceId?: string }) => Promise<BuiltColdStore>;
}

export interface ColdStoreAdminStoreOpts {
  databaseUrl: string;
  instanceId?: string;
}

export interface ColdStoreAdminChunkOpts extends ColdStoreAdminStoreOpts {
  chunkId: string;
  table: string;
  tenant: string;
  partitionDate: string;
}

export interface ColdStoreAdminPurgeOpts extends ColdStoreAdminStoreOpts {
  table?: string;
  bucket?: string;
  limit?: number;
}

interface ChunkListing {
  chunkId: string;
  tenantId: string;
  partitionDate: string;
  dataKey: string | null;
  manifestKey: string | null;
}

interface ChunkKeyGroup {
  chunkId: string;
  tenantId: string;
  partitionDate: string;
  /** Cold-retention bucket segment of a per-bucket (v2) chunk; absent for a v1 chunk. */
  bucket?: string;
  dataKey?: string;
  manifestKey?: string;
}

async function withStore<T>(
  side: ColdStoreAdminSide,
  opts: ColdStoreAdminStoreOpts,
  fn: (b: BuiltColdStore) => Promise<T>,
): Promise<T> {
  const b = await side.build({ databaseUrl: opts.databaseUrl, instanceId: opts.instanceId });
  try {
    return await fn(b);
  } finally {
    await b.close();
  }
}

/** Throw the operator-facing error when the cold store is disabled. */
export function assertColdStoreEnabled(b: Pick<BuiltColdStore, 'enabled'>): void {
  if (!b.enabled) {
    throw new Error(
      'cold-store is disabled: set KICI_COLD_STORE_ENABLED=true and KICI_COLD_STORE_BUCKET before using this subcommand',
    );
  }
}

function requireAdapter(
  side: ColdStoreAdminSide,
  b: BuiltColdStore,
  table: string,
): TableAdapter<unknown> {
  const adapter = b.store.getAdapter(table);
  if (!adapter) {
    throw new Error(
      `no cold-store adapter registered for table '${table}' on ${side.label}; registered: ${
        b.store
          .listAdapters()
          .map((a) => a.table)
          .join(', ') || '(none)'
      }`,
    );
  }
  return adapter;
}

function dayStart(partitionDate: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(partitionDate)) {
    throw new Error(`--partition-date must be YYYY-MM-DD, got ${partitionDate}`);
  }
  return new Date(`${partitionDate}T00:00:00.000Z`);
}

function parseDate(flag: string, raw: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`${flag} is not a valid date: ${raw}`);
  return d;
}

/**
 * Resolve a chunk's object keys. A v1 chunk sits at the tenant-day root and
 * a per-bucket (v2) chunk under a `<bucket>` subprefix, and the operator
 * names neither, so this lists the day and matches the chunk id. A chunk
 * with no object resolves to its v1 key, whose read then fails with the
 * object store's not-found error.
 */
async function resolveChunkKeys(
  side: ColdStoreAdminSide,
  b: BuiltColdStore,
  opts: ColdStoreAdminChunkOpts,
): Promise<{ dataKey: string; manifestKey: string }> {
  const keyArgs = {
    prefix: b.prefix,
    db: side.db,
    table: opts.table,
    tenantId: opts.tenant,
    partitionDate: opts.partitionDate,
  };
  const dayKeys = await b.store.listObjectKeys(tenantDayPrefix(keyArgs) + '/');
  const find = (kind: 'data' | 'manifest'): string => {
    const v1 = chunkObjectKey({ ...keyArgs, chunkId: opts.chunkId, kind });
    const suffix = v1.slice(v1.lastIndexOf('/'));
    return dayKeys.find((k) => k.endsWith(suffix)) ?? v1;
  };
  return { dataKey: find('data'), manifestKey: find('manifest') };
}

/**
 * List the table's (optionally one tenant's) chunk objects and group the
 * data and manifest keys of each chunk. `skip` drops a chunk by its
 * partition date before it is grouped.
 */
async function groupChunkKeys(
  side: ColdStoreAdminSide,
  b: BuiltColdStore,
  table: string,
  tenant: string | undefined,
  skip: (partitionDate: string) => boolean = () => false,
): Promise<Map<string, ChunkKeyGroup>> {
  const prefix =
    tablePrefix({ prefix: b.prefix, db: side.db, table }) +
    (tenant ? `/${encodeKeySegment(tenant)}/` : '/');
  const keys = await b.store.listObjectKeys(prefix);
  const keyRe = new RegExp(
    `/${side.db}/[^/]+/([^/]+)/(\\d{4})/(\\d{2})/(\\d{2})/(?:([a-z0-9]+)/)?([a-f0-9]+)\\.(jsonl\\.gz|manifest\\.json)$`,
  );
  const groups = new Map<string, ChunkKeyGroup>();
  for (const key of keys) {
    const m = key.match(keyRe);
    if (!m) continue;
    const [, tenantId, y, mo, d, bucket, chunkId, ext] = m;
    const partitionDate = `${y}-${mo}-${d}`;
    if (skip(partitionDate)) continue;
    const gk = `${tenantId}|${partitionDate}|${chunkId}`;
    const g = groups.get(gk) ?? { chunkId, tenantId, partitionDate, bucket };
    if (ext === 'jsonl.gz') g.dataKey = key;
    else g.manifestKey = key;
    groups.set(gk, g);
  }
  return groups;
}

/**
 * Run one synchronous archive cycle restricted to a single registered
 * adapter, for an operator who wants to flush a freshly-eligible
 * partition immediately rather than wait for the hourly cron tick.
 */
async function archiveNow(
  side: ColdStoreAdminSide,
  opts: ColdStoreAdminStoreOpts & { table: string },
): Promise<void> {
  await withStore(side, opts, async (b) => {
    assertColdStoreEnabled(b);
    requireAdapter(side, b, opts.table);
    const summary = await b.store.runArchiveCycle({ tableFilter: opts.table });
    process.stdout.write(
      `archive-now ${opts.table}: tablesProcessed=${summary.tablesProcessed} chunksWritten=${summary.chunksWritten} rowsArchived=${summary.rowsArchived} rowsFailed=${summary.rowsFailed}\n`,
    );
  });
}

async function dryRunArchive(
  side: ColdStoreAdminSide,
  opts: ColdStoreAdminStoreOpts & { table: string; tenant?: string; from?: string; to?: string },
): Promise<void> {
  await withStore(side, opts, async (b) => {
    const adapter = requireAdapter(side, b, opts.table);
    const warmCutoff = new Date(Date.now() - adapter.config.warmTtlDays * 86_400_000);
    const fromTs = opts.from ? parseDate('--from', opts.from) : null;
    const toTs = opts.to ? parseDate('--to', opts.to) : null;
    type Row = { tenantId: string; partitionDate: string; bytes: number };
    const results: Row[] = [];
    for await (const p of adapter.listEligiblePartitions({ warmCutoff })) {
      if (opts.tenant && p.tenantId !== opts.tenant) continue;
      const dayTs = dayStart(p.partitionDate);
      if (fromTs && dayTs < fromTs) continue;
      if (toTs && dayTs >= toTs) continue;
      const bytes = await adapter.countTenantWarmBytes({ tenantId: p.tenantId, warmCutoff });
      results.push({ tenantId: p.tenantId, partitionDate: p.partitionDate, bytes });
    }
    if (results.length === 0) {
      process.stdout.write(`dry-run-archive ${opts.table}: 0 rows eligible\n`);
      return;
    }
    let totalBytes = 0;
    for (const r of results) {
      process.stdout.write(`  ${r.tenantId}\t${r.partitionDate}\t~${r.bytes} bytes (approx)\n`);
      totalBytes += r.bytes;
    }
    process.stdout.write(
      `dry-run-archive ${opts.table}: ${results.length} eligible partition(s), ~${totalBytes} bytes (approx, no writes)\n`,
    );
  });
}

async function listChunks(
  side: ColdStoreAdminSide,
  opts: ColdStoreAdminStoreOpts & {
    table: string;
    tenant?: string;
    missingData?: boolean;
    missingManifest?: boolean;
    from?: string;
    to?: string;
  },
): Promise<void> {
  await withStore(side, opts, async (b) => {
    assertColdStoreEnabled(b);
    requireAdapter(side, b, opts.table);
    const groups = await groupChunkKeys(side, b, opts.table, opts.tenant, (partitionDate) => {
      const fromTs = opts.from ? parseDate('--from', opts.from) : null;
      const toTs = opts.to ? parseDate('--to', opts.to) : null;
      const dayTs = dayStart(partitionDate);
      return Boolean((fromTs && dayTs < fromTs) || (toTs && dayTs >= toTs));
    });

    let listings: ChunkListing[] = Array.from(groups.values()).map((g) => ({
      chunkId: g.chunkId,
      tenantId: g.tenantId,
      partitionDate: g.partitionDate,
      dataKey: g.dataKey ?? null,
      manifestKey: g.manifestKey ?? null,
    }));
    listings.sort((a, c) =>
      a.tenantId === c.tenantId
        ? a.partitionDate.localeCompare(c.partitionDate) || a.chunkId.localeCompare(c.chunkId)
        : a.tenantId.localeCompare(c.tenantId),
    );
    if (opts.missingData) listings = listings.filter((l) => l.dataKey === null);
    if (opts.missingManifest) listings = listings.filter((l) => l.manifestKey === null);

    if (listings.length === 0) {
      process.stdout.write('no chunks registered\n');
      return;
    }
    for (const l of listings) {
      process.stdout.write(JSON.stringify(l) + '\n');
    }
  });
}

/** Read a chunk's data and manifest, and compare the data's sha256 with the manifest's. */
async function readVerifiedChunk(
  side: ColdStoreAdminSide,
  b: BuiltColdStore,
  opts: ColdStoreAdminChunkOpts,
): Promise<{ data: Buffer; dataKey: string; manifest: ChunkManifest; got: string }> {
  const { dataKey, manifestKey } = await resolveChunkKeys(side, b, opts);
  const [data, manifestBuf] = await Promise.all([
    b.store.getObjectBody(dataKey),
    b.store.getObjectBody(manifestKey),
  ]);
  return { data, dataKey, manifest: parseManifest(manifestBuf), got: sha256(data) };
}

async function verifyChunk(
  side: ColdStoreAdminSide,
  opts: ColdStoreAdminChunkOpts,
): Promise<'match' | 'mismatch'> {
  return withStore(side, opts, async (b) => {
    assertColdStoreEnabled(b);
    requireAdapter(side, b, opts.table);
    const { manifest, got } = await readVerifiedChunk(side, b, opts);
    if (got !== manifest.contentHash) {
      process.stderr.write(
        `verify-chunk ${opts.chunkId}: MISMATCH (got ${got}, manifest ${manifest.contentHash})\n`,
      );
      return 'mismatch';
    }
    process.stdout.write(
      `verify-chunk ${opts.chunkId}: OK (contentHash=${manifest.contentHash}, rowCount=${manifest.rowCount}, bytes=${manifest.byteCount})\n`,
    );
    return 'match';
  });
}

/**
 * Re-run UPDATE+DELETE+audit for a chunk that landed in S3 while its rows
 * are still in Postgres (the crash-recovery primitive).
 */
async function replayChunk(side: ColdStoreAdminSide, opts: ColdStoreAdminChunkOpts): Promise<void> {
  await withStore(side, opts, async (b) => {
    assertColdStoreEnabled(b);
    const adapter = requireAdapter(side, b, opts.table);
    const { data, dataKey, manifest, got } = await readVerifiedChunk(side, b, opts);
    if (got !== manifest.contentHash) {
      throw new Error(
        `replay-chunk ${opts.chunkId}: refusing to replay — contentHash mismatch (got ${got}, manifest ${manifest.contentHash})`,
      );
    }
    const rowIds: Array<string | number> = [];
    for await (const row of decodeChunk<unknown>({ gzipped: data })) {
      rowIds.push(adapter.rowId(row as never));
    }
    if (rowIds.length === 0) {
      process.stdout.write(`replay-chunk ${opts.chunkId}: chunk is empty (no rows to replay)\n`);
      return;
    }
    await adapter.markArchivedAndDelete({
      rowIds,
      chunkMeta: {
        chunkId: manifest.chunkId,
        tenantId: manifest.tenantId,
        partitionDate: manifest.partitionDate,
        rowCount: manifest.rowCount,
        byteCount: manifest.byteCount,
        gzipByteCount: manifest.gzipByteCount,
        objectKey: dataKey,
      },
    });
    process.stdout.write(
      `replay-chunk ${opts.chunkId}: UPDATE+DELETE+audit committed for ${rowIds.length} row(s)\n`,
    );
  });
}

/**
 * Promote every row in a chunk back into Postgres, clearing `archived_at`
 * and writing a `replay_chunk` audit row: the inverse of `replayChunk`.
 * The adapter must implement `replayInsert` — currently only
 * `execution_runs`.
 */
async function replayIntoPg(
  side: ColdStoreAdminSide,
  opts: ColdStoreAdminChunkOpts,
): Promise<void> {
  await withStore(side, opts, async (b) => {
    assertColdStoreEnabled(b);
    requireAdapter(side, b, opts.table);
    const result = await b.store.replayChunk({
      db: side.db,
      table: opts.table,
      tenantId: opts.tenant,
      partitionDate: opts.partitionDate,
      chunkId: opts.chunkId,
    });
    process.stdout.write(
      `replay-into-pg ${opts.chunkId}: inserted ${result.inserted}, skipped ${result.skipped}\n`,
    );
  });
}

/**
 * The `maxColdDays` a rebuilt per-bucket (v2) manifest records: the longest
 * row retention, as the archiver computes it. `undefined` for a v1 chunk;
 * `null` (after printing why) when the adapter cannot compute it.
 */
function bucketRetention(
  adapter: TableAdapter<unknown>,
  rows: unknown[],
  entry: ChunkKeyGroup,
): ColdRetention | undefined | null {
  if (entry.bucket === undefined) return undefined;
  if (!adapter.coldTtlDays) {
    process.stderr.write(
      `reconcile: chunk ${entry.chunkId} sits under bucket '${entry.bucket}' but table '${adapter.table}' has no per-row cold retention; not rebuilding manifest\n`,
    );
    return null;
  }
  let max = adapter.coldTtlDays(rows[0] as never);
  for (const r of rows) {
    const ttl = adapter.coldTtlDays(r as never);
    if (isLongerColdRetention(ttl, max)) max = ttl;
  }
  return max;
}

/**
 * Rebuild the manifest of one chunk whose data file has none. Returns
 * false (after printing why) when the chunk is left alone.
 */
async function rebuildManifest(
  side: ColdStoreAdminSide,
  b: BuiltColdStore,
  adapter: TableAdapter<unknown>,
  table: string,
  entry: ChunkKeyGroup & { dataKey: string },
): Promise<boolean> {
  const data = await b.store.getObjectBody(entry.dataKey);
  const got = sha256(data);
  const rows: unknown[] = [];
  for await (const row of decodeChunk<unknown>({ gzipped: data })) {
    rows.push(row);
  }
  if (rows.length === 0) {
    process.stderr.write(
      `reconcile: chunk ${entry.chunkId} data file decodes to 0 rows; not rebuilding manifest\n`,
    );
    return false;
  }
  let minRowId = adapter.rowId(rows[0] as never);
  let maxRowId = minRowId;
  let minTs = new Date((adapter.rowTimestamp(rows[0] as never) as Date | string).toString());
  let maxTs = minTs;
  // The natural-key index `replayRow` searches first, rebuilt as the archiver writes it.
  const replayLookupKeys: string[] = [];
  for (const r of rows) {
    const rid = adapter.rowId(r as never);
    if (compareRowIds(rid, minRowId) < 0) minRowId = rid;
    if (compareRowIds(rid, maxRowId) > 0) maxRowId = rid;
    const ts = new Date((adapter.rowTimestamp(r as never) as Date | string).toString());
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
    const tok = adapter.replayLookupKey?.(r as never);
    if (tok !== undefined) replayLookupKeys.push(tok);
  }
  const derivedChunkId = computeChunkId({
    db: side.db,
    table,
    tenantId: entry.tenantId,
    partitionDate: entry.partitionDate,
    minRowId,
    maxRowId,
  });
  if (derivedChunkId !== entry.chunkId) {
    process.stderr.write(
      `reconcile: derived chunkId ${derivedChunkId} does not match S3 key's ${entry.chunkId}; skipping (suspicious — possible tampering)\n`,
    );
    return false;
  }
  const retention = bucketRetention(adapter, rows, entry);
  if (retention === null) return false;
  const v1: ChunkManifest = {
    schemaVersion: 1,
    db: side.db,
    table,
    tenantId: entry.tenantId,
    partitionDate: entry.partitionDate,
    rowCount: rows.length,
    byteCount: 0, // Unknown without re-encoding; 0 signals "rebuilt".
    gzipByteCount: data.byteLength,
    minTimestamp: minTs.toISOString(),
    maxTimestamp: maxTs.toISOString(),
    minRowId,
    maxRowId,
    contentHash: got,
    chunkId: entry.chunkId,
    createdAt: new Date().toISOString(),
    archiverInstanceId: side.reconcileInstanceId,
    ...(replayLookupKeys.length > 0 ? { replayLookupKeys } : {}),
  };
  const manifest: ChunkManifest = retention
    ? { ...v1, schemaVersion: 2, bucket: entry.bucket, maxColdDays: retention }
    : v1;
  const manifestKey = chunkObjectKey({
    prefix: b.prefix,
    db: side.db,
    table,
    tenantId: entry.tenantId,
    partitionDate: entry.partitionDate,
    chunkId: entry.chunkId,
    kind: 'manifest',
    bucket: entry.bucket,
  });
  await b.store.putManifestObject(manifestKey, manifest);
  process.stdout.write(`reconcile: rebuilt manifest for ${entry.chunkId} (${rows.length} rows)\n`);
  return true;
}

async function reconcile(
  side: ColdStoreAdminSide,
  opts: ColdStoreAdminStoreOpts & {
    table: string;
    tenant?: string;
    /** @deprecated Has no effect: reconcile only rebuilds manifests. Removed in v1.0.0. */
    confirmCleanup?: boolean;
  },
): Promise<void> {
  if (opts.confirmCleanup) {
    process.stderr.write(
      'reconcile: --confirm-cleanup is deprecated and has no effect; it is removed in v1.0.0\n',
    );
  }
  await withStore(side, opts, async (b) => {
    assertColdStoreEnabled(b);
    const adapter = requireAdapter(side, b, opts.table);
    const byId = await groupChunkKeys(side, b, opts.table, opts.tenant);

    let orphansRepaired = 0;
    let dataMissing = 0;
    for (const entry of byId.values()) {
      if (entry.dataKey && entry.manifestKey) continue;
      if (!entry.dataKey) {
        process.stderr.write(
          `reconcile: DATA MISSING for chunk ${entry.chunkId} (${entry.tenantId} ${entry.partitionDate}); manifest key ${entry.manifestKey}. Check S3 object versions.\n`,
        );
        dataMissing += 1;
        continue;
      }
      const dataKey = entry.dataKey;
      if (await rebuildManifest(side, b, adapter, opts.table, { ...entry, dataKey })) {
        orphansRepaired += 1;
      }
    }
    process.stdout.write(
      `reconcile ${opts.table}: orphans_repaired=${orphansRepaired} data_missing=${dataMissing} total_chunks=${byId.size}\n`,
    );
  });
}

/**
 * List chunks past their cold-retention horizon. Read-only; no S3 or
 * Postgres mutation. Emits one JSON line per row so the output pipes
 * through `jq` / `column -t`.
 */
async function listPurgeable(
  side: ColdStoreAdminSide,
  opts: ColdStoreAdminPurgeOpts,
): Promise<void> {
  await withStore(side, opts, async (b) => {
    assertColdStoreEnabled(b);
    const summary = await b.store.purgeExpiredChunks({
      tableFilter: opts.table,
      bucketFilter: opts.bucket,
      limit: opts.limit ?? 1000,
      dryRun: true,
    });
    for (const r of summary.results) {
      process.stdout.write(JSON.stringify(r) + '\n');
    }
    process.stderr.write(
      `cold-store list-purgeable: ${summary.results.length} candidate(s) in ${summary.durationMs}ms\n`,
    );
  });
}

/**
 * Delete the S3 objects and Postgres bookkeeping of chunks past their
 * cold-retention horizon. Defaults to a dry run; `apply` deletes.
 */
async function purgeNow(
  side: ColdStoreAdminSide,
  opts: ColdStoreAdminPurgeOpts & { apply?: boolean },
): Promise<void> {
  await withStore(side, opts, async (b) => {
    assertColdStoreEnabled(b);
    const dryRun = !opts.apply;
    const summary = await b.store.purgeExpiredChunks({
      tableFilter: opts.table,
      bucketFilter: opts.bucket,
      limit: opts.limit ?? 1000,
      dryRun,
    });
    for (const r of summary.results) {
      process.stdout.write(JSON.stringify(r) + '\n');
    }
    process.stderr.write(
      `cold-store purge-now (${dryRun ? 'DRY RUN' : 'APPLIED'}): ${summary.chunksPurged} purged / ${summary.results.length} candidates / ${summary.bytesPurged} bytes / ${summary.durationMs}ms\n`,
    );
    if (dryRun && summary.results.length > 0) {
      process.stderr.write(
        'No deletions performed — pass --apply to actually purge these chunks.\n',
      );
    }
  });
}

async function peekChunk(
  side: ColdStoreAdminSide,
  opts: ColdStoreAdminChunkOpts & { limit: number },
): Promise<void> {
  await withStore(side, opts, async (b) => {
    assertColdStoreEnabled(b);
    requireAdapter(side, b, opts.table);
    const { dataKey } = await resolveChunkKeys(side, b, opts);
    const data = await b.store.getObjectBody(dataKey);
    let count = 0;
    for await (const row of decodeChunk<unknown>({ gzipped: data })) {
      if (count >= opts.limit) break;
      process.stdout.write(JSON.stringify(row) + '\n');
      count += 1;
    }
  });
}

type SideOp<A extends unknown[], R> = (side: ColdStoreAdminSide, ...args: A) => R;

function bind<A extends unknown[], R>(side: ColdStoreAdminSide, op: SideOp<A, R>) {
  return (...args: A): R => op(side, ...args);
}

/** Bind every cold-store admin op to one side. */
export function createColdStoreAdminOps(side: ColdStoreAdminSide) {
  return {
    archiveNow: bind(side, archiveNow),
    dryRunArchive: bind(side, dryRunArchive),
    listChunks: bind(side, listChunks),
    verifyChunk: bind(side, verifyChunk),
    replayChunk: bind(side, replayChunk),
    replayIntoPg: bind(side, replayIntoPg),
    reconcile: bind(side, reconcile),
    listPurgeable: bind(side, listPurgeable),
    purgeNow: bind(side, purgeNow),
    peekChunk: bind(side, peekChunk),
  };
}
