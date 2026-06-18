/**
 * Orchestrator-side cold-store.
 *
 * Extends BaseColdStore with orchestrator-specific table adapters.
 * Phase A registered no adapters; Phase C added execution_runs /
 * execution_jobs / execution_steps. Phase D adds secret_audit_log
 * and access_log.
 */
import { sql, type Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  BaseColdStore,
  type BaseColdStoreDeps,
  type ColdStoreConfig,
  type ColdStoreTableConfig,
  type PurgeableChunk,
  type SharedS3Config,
} from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import { ExecutionStepsAdapter } from './tables/execution-steps.js';
import { ExecutionJobsAdapter } from './tables/execution-jobs.js';
import { ExecutionRunsAdapter } from './tables/execution-runs.js';
import { SecretAuditLogAdapter } from './tables/secret-audit-log.js';
import { AccessLogAdapter } from './tables/access-log.js';
import { EventLogAdapter } from './tables/event-log.js';

const handlerLogger = createLogger({ prefix: 'cold-store-archive' });
const purgeHandlerLogger = createLogger({ prefix: 'cold-store-purge' });

export interface OrchestratorColdStoreDeps extends Omit<BaseColdStoreDeps, 'db'> {
  /** Kysely handle used by every registered Orchestrator adapter. */
  kdb: Kysely<Database>;
}

export class OrchestratorColdStore extends BaseColdStore {
  private readonly kdb: Kysely<Database>;

  constructor(deps: OrchestratorColdStoreDeps) {
    super({ ...deps, db: 'orchestrator' });
    this.kdb = deps.kdb;
    // Phase C: register steps → jobs → runs so the FK
    // `execution_jobs.run_id → execution_runs(run_id)` doesn't fire on
    // DELETE. The adapters' eligibility predicates also enforce this
    // ordering across cycle interruptions.
    this.registerAdapter(
      new ExecutionStepsAdapter(deps.kdb, deps.instanceId, {
        overrides: deps.config.tables.execution_steps ?? deps.config.tables['execution_steps'],
      }),
    );
    this.registerAdapter(
      new ExecutionJobsAdapter(deps.kdb, deps.instanceId, {
        overrides: deps.config.tables.execution_jobs ?? deps.config.tables['execution_jobs'],
      }),
    );
    this.registerAdapter(
      new ExecutionRunsAdapter(deps.kdb, deps.instanceId, {
        overrides: deps.config.tables.execution_runs ?? deps.config.tables['execution_runs'],
      }),
    );
    // Phase D: secret_audit_log + access_log. Both are independent of
    // execution_* (no FKs); order is irrelevant. Access_log goes last
    // because the run/job/step archives in this same cycle write
    // recursive access_log rows — letting access_log archive last
    // means those new rows are picked up next cycle, not this one
    // (which would otherwise read-after-write within the same tx
    // boundary spanning multiple adapters).
    this.registerAdapter(
      new SecretAuditLogAdapter(deps.kdb, deps.instanceId, {
        overrides: deps.config.tables.secret_audit_log ?? deps.config.tables['secret_audit_log'],
      }),
    );
    this.registerAdapter(
      new AccessLogAdapter(deps.kdb, deps.instanceId, {
        overrides: deps.config.tables.access_log ?? deps.config.tables['access_log'],
      }),
    );
    // Phase E: event_log. Independent of every other adapter (no FKs).
    // Registered after access_log so that the recursive access_log row
    // emitted by markArchivedAndDelete is processed in the next cycle
    // — same reasoning as access_log's own placement.
    this.registerAdapter(
      new EventLogAdapter(deps.kdb, deps.instanceId, {
        overrides: deps.config.tables.event_log ?? deps.config.tables['event_log'],
      }),
    );
  }

  /**
   * Phase 2 — query the orchestrator's `cold_store_chunks` table for
   * chunks past their per-row cold-retention horizon. See the matching
   * Platform-side method for the full rationale.
   */
  protected override async listPurgeableChunks(opts: {
    tableFilter?: string;
    bucketFilter?: string;
    limit: number;
  }): Promise<PurgeableChunk[]> {
    const tableFilter = opts.tableFilter;
    const bucketFilter = opts.bucketFilter;
    const rows = await sql<{
      table_name: string;
      tenant_id: string;
      chunk_id: string;
      bucket: string;
      archived_at: Date;
      gzip_bytes: string;
      row_count: string;
      max_cold_days: string;
      object_key: string;
    }>`
      SELECT table_name, tenant_id, chunk_id, bucket, archived_at,
             gzip_bytes::text AS gzip_bytes,
             row_count::text AS row_count,
             max_cold_days, object_key
      FROM cold_store_chunks
      WHERE db = 'orchestrator'
        AND max_cold_days != 'forever'
        AND (${tableFilter}::text IS NULL OR table_name = ${tableFilter})
        AND (${bucketFilter}::text IS NULL OR bucket = ${bucketFilter})
        AND archived_at + (max_cold_days || ' days')::interval < now()
      ORDER BY archived_at
      LIMIT ${opts.limit}
    `.execute(this.kdb);
    return rows.rows.map((r) => ({
      table: r.table_name,
      tenantId: r.tenant_id,
      chunkId: r.chunk_id,
      bucket: r.bucket,
      archivedAt: r.archived_at,
      gzipBytes: Number(r.gzip_bytes),
      rowCount: Number(r.row_count),
      maxColdDays: Number(r.max_cold_days),
      objectKey: r.object_key,
    }));
  }

  /**
   * Phase 2 — per-chunk advisory lock keyed on
   * `hashtext('cold-store-purge|orchestrator|<table>|<chunkId>')`.
   */
  protected override async withPurgeLock<T>(
    args: { table: string; chunkId: string },
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const key = `cold-store-purge|orchestrator|${args.table}|${args.chunkId}`;
    return await this.kdb.connection().execute(async (conn) => {
      const lockRes = await sql<{ locked: boolean }>`
        SELECT pg_try_advisory_lock(hashtext(${key})) AS locked
      `.execute(conn);
      const locked = lockRes.rows[0]?.locked === true;
      if (!locked) return null;
      try {
        return await fn();
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtext(${key}))`.execute(conn).catch(() => undefined);
      }
    });
  }
}

/**
 * Build the orchestrator cold-store config from env vars. Reads
 * `KICI_COLD_STORE_*` vars mirrored with the Platform side. YAML
 * integration (per the design doc) lands in a follow-up commit that
 * wires the `coldStore` section of the orchestrator config schema;
 * Phase A ships the env-var path only.
 */
export function readOrchestratorColdStoreConfig(
  env: NodeJS.ProcessEnv = process.env,
): ColdStoreConfig {
  const enabled = env.KICI_COLD_STORE_ENABLED === 'true';
  const bucket = env.KICI_COLD_STORE_BUCKET ?? '';
  const prefix = env.KICI_COLD_STORE_PREFIX ?? 'cold-store/';

  const storage: SharedS3Config = {
    bucket,
    prefix,
    region: env.KICI_COLD_STORE_REGION,
    endpoint: env.KICI_COLD_STORE_ENDPOINT,
    externalEndpoint: env.KICI_COLD_STORE_EXTERNAL_ENDPOINT,
    forcePathStyle: env.KICI_COLD_STORE_FORCE_PATH_STYLE === 'true' ? true : undefined,
  };

  return {
    enabled: enabled && bucket.length > 0,
    storage,
    s3Concurrency: parseNumber(env.KICI_COLD_STORE_S3_CONCURRENCY, 4),
    tables: readTableOverrides(env),
  };
}

/**
 * Per-table tuning overrides from env. Mirrors the Platform pattern in
 * `platform-cold-store.ts`. Pattern:
 *
 *   KICI_COLD_STORE_<TABLE>_WARM_TTL_DAYS
 *   KICI_COLD_STORE_<TABLE>_MIN_WARM_TENANT_BYTES
 *   KICI_COLD_STORE_<TABLE>_MIN_CHUNK_BYTES
 *   KICI_COLD_STORE_<TABLE>_MAX_CHUNK_BYTES
 *   KICI_COLD_STORE_<TABLE>_MAX_ROWS_PER_CYCLE
 *   KICI_COLD_STORE_<TABLE>_ENABLED  (true|false)
 *
 * The table name is upper-snake-cased (e.g. execution_runs → EXECUTION_RUNS).
 */
function readTableOverrides(env: NodeJS.ProcessEnv): Record<string, Partial<ColdStoreTableConfig>> {
  const tables: Record<string, Partial<ColdStoreTableConfig>> = {};
  const knownTables = [
    'execution_runs',
    'execution_jobs',
    'execution_steps',
    'secret_audit_log',
    'access_log',
    'event_log',
  ];
  for (const table of knownTables) {
    const up = table.toUpperCase();
    const override: Partial<ColdStoreTableConfig> = {};
    const warm = env[`KICI_COLD_STORE_${up}_WARM_TTL_DAYS`];
    if (warm !== undefined && Number.isFinite(Number(warm))) override.warmTtlDays = Number(warm);
    const minWarm = env[`KICI_COLD_STORE_${up}_MIN_WARM_TENANT_BYTES`];
    if (minWarm !== undefined && Number.isFinite(Number(minWarm)))
      override.minWarmTenantBytes = Number(minWarm);
    const minChunk = env[`KICI_COLD_STORE_${up}_MIN_CHUNK_BYTES`];
    if (minChunk !== undefined && Number.isFinite(Number(minChunk)))
      override.minChunkBytes = Number(minChunk);
    const maxChunk = env[`KICI_COLD_STORE_${up}_MAX_CHUNK_BYTES`];
    if (maxChunk !== undefined && Number.isFinite(Number(maxChunk)))
      override.maxChunkBytes = Number(maxChunk);
    const maxRows = env[`KICI_COLD_STORE_${up}_MAX_ROWS_PER_CYCLE`];
    if (maxRows !== undefined && Number.isFinite(Number(maxRows)))
      override.maxRowsPerCycle = Number(maxRows);
    const enabledRaw = env[`KICI_COLD_STORE_${up}_ENABLED`];
    if (enabledRaw === 'true') override.enabled = true;
    else if (enabledRaw === 'false') override.enabled = false;
    if (Object.keys(override).length > 0) tables[table] = override;
  }
  return tables;
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build the cold-store-archive scheduled-job handler for the
 * orchestrator. Re-reads env vars on every tick so SIGHUP-driven
 * config reload picks up new bucket/prefix values without a restart.
 */
export function createColdStoreArchiveHandler(
  instanceId: string,
  kdb: Kysely<Database>,
): () => Promise<void> {
  return async () => {
    const config = readOrchestratorColdStoreConfig();
    const store = new OrchestratorColdStore({
      config,
      instanceId,
      kdb,
      log: (level, msg, extra) => {
        if (level === 'info') handlerLogger.info(msg, extra);
        else if (level === 'warn') handlerLogger.warn(msg, extra);
        else handlerLogger.error(msg, extra);
      },
    });
    try {
      const summary = await store.runArchiveCycle();
      handlerLogger.info('Cold-store cycle summary', { summary });
    } catch (err) {
      handlerLogger.error('Cold-store cycle threw', { error: toErrorMessage(err) });
      throw err;
    }
  };
}

/**
 * Phase 2 — build the cold-store-purge scheduled-job handler. Same
 * env-var re-read pattern as the archive handler so SIGHUP picks up
 * config changes mid-run.
 */
export function createColdStorePurgeHandler(
  instanceId: string,
  kdb: Kysely<Database>,
): () => Promise<void> {
  return async () => {
    const config = readOrchestratorColdStoreConfig();
    const store = new OrchestratorColdStore({
      config,
      instanceId,
      kdb,
      log: (level, msg, extra) => {
        if (level === 'info') purgeHandlerLogger.info(msg, extra);
        else if (level === 'warn') purgeHandlerLogger.warn(msg, extra);
        else purgeHandlerLogger.error(msg, extra);
      },
    });
    try {
      const summary = await store.purgeExpiredChunks({ dryRun: false });
      purgeHandlerLogger.info('Cold-store purge summary', { summary });
    } catch (err) {
      purgeHandlerLogger.error('Cold-store purge threw', { error: toErrorMessage(err) });
      throw err;
    }
  };
}
