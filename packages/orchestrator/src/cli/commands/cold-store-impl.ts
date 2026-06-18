/**
 * Phase C implementations for `kici-admin cold-store` subcommands.
 *
 * Mirrors the Platform-side implementation in
 * `packages/platform/src/admin/cold-store-commands.ts` — same shape,
 * just builds an `OrchestratorColdStore` against the orchestrator
 * Postgres + S3 instead of a `PlatformColdStore`.
 *
 * Each exported function:
 *   - takes the resolved CLI args (`databaseUrl`, table, optional flags)
 *   - builds its own `Pool + Kysely + OrchestratorColdStore` (the CLI
 *     runs once per invocation — no long-lived state)
 *   - throws on failure (caller maps to exit code)
 *   - prints results to stdout (JSON Lines for list-chunks, JSONL for
 *     peek-chunk, free-form for the others)
 *
 * Audit emission lives one level up in the command registration so we
 * can write one `access_log` breadcrumb row per CLI invocation in the
 * same shape the Platform admin CLI uses for `audit_log`.
 */
import {
  ChunkLru,
  createLogger,
  createPool,
  computeChunkId,
  chunkObjectKey,
  decodeChunk,
  encodeKeySegment,
  parseManifest,
  sha256,
  tablePrefix,
  type ChunkManifest,
  type TableAdapter,
} from '@kici-dev/shared';
import { createDb } from '../../db/client.js';
import {
  OrchestratorColdStore,
  readOrchestratorColdStoreConfig,
} from '../../cold-store/orchestrator-cold-store.js';

const logger = createLogger({ prefix: 'kici-admin-cold-store' });

interface BuiltStore {
  store: OrchestratorColdStore;
  kdb: ReturnType<typeof createDb>;
  pool: ReturnType<typeof createPool>;
  bucket: string;
  prefix: string;
  enabled: boolean;
  close: () => Promise<void>;
}

async function build(deps: { databaseUrl: string; instanceId?: string }): Promise<BuiltStore> {
  const config = readOrchestratorColdStoreConfig();
  const pool = createPool(deps.databaseUrl);
  const kdb = createDb(pool);
  const store = new OrchestratorColdStore({
    kdb,
    config,
    instanceId: deps.instanceId ?? 'kici-admin-cli',
    chunkCache: new ChunkLru<string, Buffer>({
      maxBytes: 256 * 1024 * 1024,
      sizeOf: (v) => v.byteLength,
    }),
    log: (level, msg, extra) => {
      if (level === 'info') logger.info(msg, extra);
      else if (level === 'warn') logger.warn(msg, extra);
      else logger.error(msg, extra);
    },
  });
  return {
    store,
    kdb,
    pool,
    bucket: config.storage.bucket,
    prefix: config.storage.prefix,
    enabled: config.enabled,
    close: async () => {
      await kdb.destroy();
      await pool.end().catch(() => undefined);
    },
  };
}

function assertEnabled(b: BuiltStore): void {
  if (!b.enabled) {
    throw new Error(
      'cold-store is disabled: set KICI_COLD_STORE_ENABLED=true and KICI_COLD_STORE_BUCKET before using this subcommand',
    );
  }
}

function requireAdapter(b: BuiltStore, table: string): TableAdapter<unknown> {
  const adapter = b.store.getAdapter(table);
  if (!adapter) {
    throw new Error(
      `no cold-store adapter registered for table '${table}' on Orchestrator; registered: ${
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

// ── archive-now ─────────────────────────────────────────────────────

export async function archiveNow(opts: {
  databaseUrl: string;
  table: string;
  instanceId?: string;
}): Promise<void> {
  const b = await build({ databaseUrl: opts.databaseUrl, instanceId: opts.instanceId });
  try {
    assertEnabled(b);
    requireAdapter(b, opts.table);
    const summary = await b.store.runArchiveCycle({ tableFilter: opts.table });
    process.stdout.write(
      `archive-now ${opts.table}: tablesProcessed=${summary.tablesProcessed} chunksWritten=${summary.chunksWritten} rowsArchived=${summary.rowsArchived} rowsFailed=${summary.rowsFailed}\n`,
    );
  } finally {
    await b.close();
  }
}

// ── dry-run-archive ─────────────────────────────────────────────────

export async function dryRunArchive(opts: {
  databaseUrl: string;
  table: string;
  tenant?: string;
  from?: string;
  to?: string;
  instanceId?: string;
}): Promise<void> {
  const b = await build({ databaseUrl: opts.databaseUrl, instanceId: opts.instanceId });
  try {
    const adapter = requireAdapter(b, opts.table);
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
  } finally {
    await b.close();
  }
}

// ── list-chunks ─────────────────────────────────────────────────────

export interface ChunkListing {
  chunkId: string;
  tenantId: string;
  partitionDate: string;
  dataKey: string | null;
  manifestKey: string | null;
}

export async function listChunks(opts: {
  databaseUrl: string;
  table: string;
  tenant?: string;
  missingData?: boolean;
  missingManifest?: boolean;
  from?: string;
  to?: string;
  instanceId?: string;
}): Promise<void> {
  const b = await build({ databaseUrl: opts.databaseUrl, instanceId: opts.instanceId });
  try {
    assertEnabled(b);
    requireAdapter(b, opts.table);
    const prefix =
      tablePrefix({ prefix: b.prefix, db: 'orchestrator', table: opts.table }) +
      (opts.tenant ? `/${encodeKeySegment(opts.tenant)}/` : '/');
    const keys = await b.store.listObjectKeys(prefix);

    type Group = {
      tenantId: string;
      partitionDate: string;
      chunkId: string;
      dataKey?: string;
      manifestKey?: string;
    };
    const groups = new Map<string, Group>();
    const keyRe =
      /\/orchestrator\/[^/]+\/([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\/([a-f0-9]+)\.(jsonl\.gz|manifest\.json)$/;
    for (const key of keys) {
      const m = key.match(keyRe);
      if (!m) continue;
      const [, tenant, y, mo, d, chunkId, ext] = m;
      const partitionDate = `${y}-${mo}-${d}`;
      const fromTs = opts.from ? parseDate('--from', opts.from) : null;
      const toTs = opts.to ? parseDate('--to', opts.to) : null;
      const dayTs = dayStart(partitionDate);
      if (fromTs && dayTs < fromTs) continue;
      if (toTs && dayTs >= toTs) continue;
      const gk = `${tenant}|${partitionDate}|${chunkId}`;
      const g = groups.get(gk) ?? { tenantId: tenant, partitionDate, chunkId };
      if (ext === 'jsonl.gz') g.dataKey = key;
      else g.manifestKey = key;
      groups.set(gk, g);
    }

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
  } finally {
    await b.close();
  }
}

// ── verify-chunk ────────────────────────────────────────────────────

export async function verifyChunk(opts: {
  databaseUrl: string;
  chunkId: string;
  table: string;
  tenant: string;
  partitionDate: string;
  instanceId?: string;
}): Promise<'match' | 'mismatch'> {
  const b = await build({ databaseUrl: opts.databaseUrl, instanceId: opts.instanceId });
  try {
    assertEnabled(b);
    requireAdapter(b, opts.table);
    const dataKey = chunkObjectKey({
      prefix: b.prefix,
      db: 'orchestrator',
      table: opts.table,
      tenantId: opts.tenant,
      partitionDate: opts.partitionDate,
      chunkId: opts.chunkId,
      kind: 'data',
    });
    const manifestKey = chunkObjectKey({
      prefix: b.prefix,
      db: 'orchestrator',
      table: opts.table,
      tenantId: opts.tenant,
      partitionDate: opts.partitionDate,
      chunkId: opts.chunkId,
      kind: 'manifest',
    });
    const [data, manifestBuf] = await Promise.all([
      b.store.getObjectBody(dataKey),
      b.store.getObjectBody(manifestKey),
    ]);
    const manifest = parseManifest(manifestBuf);
    const got = sha256(data);
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
  } finally {
    await b.close();
  }
}

// ── replay-chunk ────────────────────────────────────────────────────

export async function replayChunk(opts: {
  databaseUrl: string;
  chunkId: string;
  table: string;
  tenant: string;
  partitionDate: string;
  instanceId?: string;
}): Promise<void> {
  const b = await build({ databaseUrl: opts.databaseUrl, instanceId: opts.instanceId });
  try {
    assertEnabled(b);
    const adapter = requireAdapter(b, opts.table);
    const dataKey = chunkObjectKey({
      prefix: b.prefix,
      db: 'orchestrator',
      table: opts.table,
      tenantId: opts.tenant,
      partitionDate: opts.partitionDate,
      chunkId: opts.chunkId,
      kind: 'data',
    });
    const manifestKey = chunkObjectKey({
      prefix: b.prefix,
      db: 'orchestrator',
      table: opts.table,
      tenantId: opts.tenant,
      partitionDate: opts.partitionDate,
      chunkId: opts.chunkId,
      kind: 'manifest',
    });
    const [data, manifestBuf] = await Promise.all([
      b.store.getObjectBody(dataKey),
      b.store.getObjectBody(manifestKey),
    ]);
    const manifest = parseManifest(manifestBuf);
    const got = sha256(data);
    if (got !== manifest.contentHash) {
      throw new Error(
        `replay-chunk ${opts.chunkId}: refusing to replay — contentHash mismatch (got ${got}, manifest ${manifest.contentHash})`,
      );
    }
    const rowIds: Array<string | number> = [];
    for await (const row of decodeChunk<unknown>({ gzipped: data })) {
      rowIds.push((adapter as TableAdapter<unknown>).rowId(row as never));
    }
    if (rowIds.length === 0) {
      process.stdout.write(`replay-chunk ${opts.chunkId}: chunk is empty (no rows to replay)\n`);
      return;
    }
    await (adapter as TableAdapter<unknown>).markArchivedAndDelete({
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
  } finally {
    await b.close();
  }
}

// ── replay-into-pg (Phase F) ────────────────────────────────────────

/**
 * Phase F — promote a chunk's rows BACK into the orchestrator PG.
 * Mirrors the Platform-side `replayIntoPg`. Adapter must implement
 * `replayInsert` — currently only `execution_runs`.
 */
export async function replayIntoPg(opts: {
  databaseUrl: string;
  chunkId: string;
  table: string;
  tenant: string;
  partitionDate: string;
  instanceId?: string;
}): Promise<void> {
  const b = await build({ databaseUrl: opts.databaseUrl, instanceId: opts.instanceId });
  try {
    assertEnabled(b);
    requireAdapter(b, opts.table);
    const result = await b.store.replayChunk({
      db: 'orchestrator',
      table: opts.table,
      tenantId: opts.tenant,
      partitionDate: opts.partitionDate,
      chunkId: opts.chunkId,
    });
    process.stdout.write(
      `replay-into-pg ${opts.chunkId}: inserted ${result.inserted}, skipped ${result.skipped}\n`,
    );
  } finally {
    await b.close();
  }
}

// ── reconcile ───────────────────────────────────────────────────────

export async function reconcile(opts: {
  databaseUrl: string;
  table: string;
  tenant?: string;
  confirmCleanup?: boolean;
  instanceId?: string;
}): Promise<void> {
  const b = await build({ databaseUrl: opts.databaseUrl, instanceId: opts.instanceId });
  try {
    assertEnabled(b);
    const adapter = requireAdapter(b, opts.table);
    const prefix =
      tablePrefix({ prefix: b.prefix, db: 'orchestrator', table: opts.table }) +
      (opts.tenant ? `/${encodeKeySegment(opts.tenant)}/` : '/');
    const keys = await b.store.listObjectKeys(prefix);

    type Entry = {
      chunkId: string;
      tenantId: string;
      partitionDate: string;
      dataKey?: string;
      manifestKey?: string;
    };
    const byId = new Map<string, Entry>();
    const keyRe =
      /\/orchestrator\/[^/]+\/([^/]+)\/(\d{4})\/(\d{2})\/(\d{2})\/([a-f0-9]+)\.(jsonl\.gz|manifest\.json)$/;
    for (const key of keys) {
      const m = key.match(keyRe);
      if (!m) continue;
      const [, tenant, y, mo, d, chunkId, ext] = m;
      const gk = `${tenant}|${y}-${mo}-${d}|${chunkId}`;
      const entry = byId.get(gk) ?? {
        chunkId,
        tenantId: tenant,
        partitionDate: `${y}-${mo}-${d}`,
      };
      if (ext === 'jsonl.gz') entry.dataKey = key;
      else entry.manifestKey = key;
      byId.set(gk, entry);
    }

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
        continue;
      }
      let minRowId = adapter.rowId(rows[0] as never);
      let maxRowId = minRowId;
      let minTs = new Date((adapter.rowTimestamp(rows[0] as never) as Date | string).toString());
      let maxTs = minTs;
      for (const r of rows) {
        const rid = adapter.rowId(r as never);
        if (String(rid) < String(minRowId)) minRowId = rid;
        if (String(rid) > String(maxRowId)) maxRowId = rid;
        const ts = new Date((adapter.rowTimestamp(r as never) as Date | string).toString());
        if (ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
      const derivedChunkId = computeChunkId({
        db: 'orchestrator',
        table: opts.table,
        tenantId: entry.tenantId,
        partitionDate: entry.partitionDate,
        minRowId,
        maxRowId,
      });
      if (derivedChunkId !== entry.chunkId) {
        process.stderr.write(
          `reconcile: derived chunkId ${derivedChunkId} does not match S3 key's ${entry.chunkId}; skipping (suspicious — possible tampering)\n`,
        );
        continue;
      }
      const manifest: ChunkManifest = {
        schemaVersion: 1,
        db: 'orchestrator',
        table: opts.table,
        tenantId: entry.tenantId,
        partitionDate: entry.partitionDate,
        rowCount: rows.length,
        byteCount: 0,
        gzipByteCount: data.byteLength,
        minTimestamp: minTs.toISOString(),
        maxTimestamp: maxTs.toISOString(),
        minRowId,
        maxRowId,
        contentHash: got,
        chunkId: entry.chunkId,
        createdAt: new Date().toISOString(),
        archiverInstanceId: 'kici-admin-cli:reconcile',
      };
      const manifestKey = chunkObjectKey({
        prefix: b.prefix,
        db: 'orchestrator',
        table: opts.table,
        tenantId: entry.tenantId,
        partitionDate: entry.partitionDate,
        chunkId: entry.chunkId,
        kind: 'manifest',
      });
      await b.store.putManifestObject(manifestKey, manifest);
      orphansRepaired += 1;
      process.stdout.write(
        `reconcile: rebuilt manifest for ${entry.chunkId} (${rows.length} rows)\n`,
      );
    }
    process.stdout.write(
      `reconcile ${opts.table}: orphans_repaired=${orphansRepaired} data_missing=${dataMissing} total_chunks=${byId.size}\n`,
    );
  } finally {
    await b.close();
  }
}

// ── peek-chunk ──────────────────────────────────────────────────────

// ── list-purgeable ──────────────────────────────────────────────────

/**
 * Phase 2 — list chunks past their cold-retention horizon. Read-only;
 * no S3 or PG mutation. Emits one JSON line per row so the output is
 * easy to pipe through `jq` / `column -t` / etc.
 */
export async function listPurgeable(opts: {
  databaseUrl: string;
  table?: string;
  bucket?: string;
  limit?: number;
  instanceId?: string;
}): Promise<void> {
  const b = await build({ databaseUrl: opts.databaseUrl, instanceId: opts.instanceId });
  try {
    assertEnabled(b);
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
  } finally {
    await b.close();
  }
}

// ── purge-now ───────────────────────────────────────────────────────

/**
 * Phase 2 — delete S3 objects + clean up PG bookkeeping for chunks
 * past their cold-retention horizon. Defaults to dry-run; pass
 * `--apply` to actually delete.
 */
export async function purgeNow(opts: {
  databaseUrl: string;
  table?: string;
  bucket?: string;
  limit?: number;
  apply?: boolean;
  instanceId?: string;
}): Promise<void> {
  const b = await build({ databaseUrl: opts.databaseUrl, instanceId: opts.instanceId });
  try {
    assertEnabled(b);
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
  } finally {
    await b.close();
  }
}

export async function peekChunk(opts: {
  databaseUrl: string;
  chunkId: string;
  table: string;
  tenant: string;
  partitionDate: string;
  limit: number;
  instanceId?: string;
}): Promise<void> {
  const b = await build({ databaseUrl: opts.databaseUrl, instanceId: opts.instanceId });
  try {
    assertEnabled(b);
    requireAdapter(b, opts.table);
    const dataKey = chunkObjectKey({
      prefix: b.prefix,
      db: 'orchestrator',
      table: opts.table,
      tenantId: opts.tenant,
      partitionDate: opts.partitionDate,
      chunkId: opts.chunkId,
      kind: 'data',
    });
    const data = await b.store.getObjectBody(dataKey);
    let count = 0;
    for await (const row of decodeChunk<unknown>({ gzipped: data })) {
      if (count >= opts.limit) break;
      process.stdout.write(JSON.stringify(row) + '\n');
      count += 1;
    }
  } finally {
    await b.close();
  }
}
