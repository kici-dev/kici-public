/**
 * `secret_audit_log` cold-store adapter (Orchestrator side).
 *
 *
 * Contract:
 *   - tenant column: `routing_key` (NULL → synthetic `__orchestrator__`)
 *   - partition column: `timestamp`
 *   - warm TTL: 90 days (longer window than other audit tables — design
 *     §5 matrix row 10. Volume is low, forensic value is high)
 *
 * Synthetic tenant: rows without `routing_key` (e.g. orchestrator-level
 * key rotations done before any source is bound) collapse to a single
 * synthetic prefix `__orchestrator__`. Mirrors the same pattern already
 * used for `event_log` payload keys when the routing key is missing.
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  type ChunkCommitMetadata,
  type ColdRetention,
  type ColdStoreTableConfig,
  type EligiblePartition,
  type TableAdapter,
} from '@kici-dev/shared';
import {
  getSecretAuditLogColdDays,
  minSecretAuditLogWarmDays,
  secretAuditLogWarmSqlCase,
} from '@kici-dev/engine';
import type { Database, SecretAuditLogTable } from '../../db/types.js';
import { SYNTHETIC_ORCH_TENANT } from '../load-access-log-range.js';

export type SecretAuditLogRow = Selectable<SecretAuditLogTable>;

const ADVISORY_LOCK_NAMESPACE = 'cold-store|orchestrator|secret_audit_log';
const APPROX_ROW_BYTES = 400;

/**
 * Per-table defaults. `warmTtlDays` MUST equal `minSecretAuditLogWarmDays()`
 * so the framework's index-friendly partition scan doesn't pre-filter out
 * rows the per-row CASE in `secretAuditLogWarmSqlCase()` would consider
 * eligible. The CASE further tightens eligibility per row based on action /
 * outcome — sampled `resolve` / `resolve_named` rows can archive at 30d
 * (matching the post-sampling 1% volume), while mutations stay 365d.
 *
 * Lowered from 90d (the prior table-wide default) to 30d as part of the audit
 * per-category retention work; the `archive_chunk`-recording recursive pattern
 * stays bounded since mutations stay in the 365d bucket.
 */
const DEFAULT_CONFIG: ColdStoreTableConfig = {
  warmTtlDays: minSecretAuditLogWarmDays(),
  minWarmTenantBytes: 1 * 1024 * 1024,
  minChunkBytes: 1 * 1024 * 1024,
  maxChunkBytes: 50 * 1024 * 1024,
  maxRowsPerCycle: 50_000,
  enabled: true,
};

export interface SecretAuditLogAdapterOptions {
  overrides?: Partial<ColdStoreTableConfig>;
}

export class SecretAuditLogAdapter implements TableAdapter<SecretAuditLogRow> {
  readonly db = 'orchestrator' as const;
  readonly table = 'secret_audit_log';
  readonly tenantColumn = 'routing_key';
  readonly partitionColumn = 'timestamp';
  readonly config: ColdStoreTableConfig;

  constructor(
    private readonly kdb: Kysely<Database>,
    private readonly instanceId: string,
    opts: SecretAuditLogAdapterOptions = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...(opts.overrides ?? {}) };
  }

  async *listEligiblePartitions(args: { warmCutoff: Date }): AsyncIterable<EligiblePartition> {
    // `idx_secret_audit_log_routing_timestamp` (migration 007) makes
    // this scan cheap. COALESCE folds NULL routing_key into the
    // synthetic tenant. `sql.lit` produces an inline literal so PG
    // sees the SELECT and GROUP BY expressions as identical (a
    // parameter binding would create two distinct $N placeholders and
    // PG would reject the SELECT as referencing routing_key without it
    // appearing in the GROUP BY).
    //
    // The per-row `retentionCase` (engine-generated CASE) further tightens
    // the index-friendly `< warmCutoff` predicate so partitions whose only
    // rows are mutations (365d) aren't yielded just because the framework's
    // 30d minimum cutoff has passed.
    const synthetic = sql.lit(SYNTHETIC_ORCH_TENANT);
    const retentionCase = sql.raw(secretAuditLogWarmSqlCase());
    const rows = await sql<{ tenant_id: string; partition_date: string }>`
      SELECT COALESCE(routing_key, ${synthetic}) AS tenant_id,
             TO_CHAR(DATE("timestamp"), 'YYYY-MM-DD') AS partition_date
      FROM secret_audit_log
      WHERE "timestamp" < ${args.warmCutoff}
        AND "timestamp" < (NOW() - (${retentionCase}))
      GROUP BY COALESCE(routing_key, ${synthetic}), DATE("timestamp")
      ORDER BY tenant_id, partition_date
    `.execute(this.kdb);
    for (const r of rows.rows) {
      yield { tenantId: r.tenant_id, partitionDate: r.partition_date };
    }
  }

  async countTenantWarmBytes(args: { tenantId: string; warmCutoff: Date }): Promise<number> {
    const isSynthetic = args.tenantId === SYNTHETIC_ORCH_TENANT;
    const retentionCase = sql.raw(secretAuditLogWarmSqlCase());
    const res = isSynthetic
      ? await sql<{ n: string }>`
          SELECT COUNT(*)::text AS n
          FROM secret_audit_log
          WHERE routing_key IS NULL
            AND "timestamp" < ${args.warmCutoff}
            AND "timestamp" < (NOW() - (${retentionCase}))
        `.execute(this.kdb)
      : await sql<{ n: string }>`
          SELECT COUNT(*)::text AS n
          FROM secret_audit_log
          WHERE routing_key = ${args.tenantId}
            AND "timestamp" < ${args.warmCutoff}
            AND "timestamp" < (NOW() - (${retentionCase}))
        `.execute(this.kdb);
    const n = Number(res.rows[0]?.n ?? '0');
    return Number.isFinite(n) ? n * APPROX_ROW_BYTES : 0;
  }

  async withPartitionLock<T>(
    args: { tenantId: string; partitionDate: string },
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const key = `${ADVISORY_LOCK_NAMESPACE}|${args.tenantId}|${args.partitionDate}`;
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

  async *selectEligible(args: {
    tenantId: string;
    partitionDate: string;
    limit: number;
  }): AsyncIterable<SecretAuditLogRow> {
    const dayStart = new Date(`${args.partitionDate}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const isSynthetic = args.tenantId === SYNTHETIC_ORCH_TENANT;
    const retentionCase = sql.raw(secretAuditLogWarmSqlCase());
    const rows = isSynthetic
      ? await sql<SecretAuditLogRow>`
          SELECT *
          FROM secret_audit_log
          WHERE routing_key IS NULL
            AND archived_at IS NULL
            AND "timestamp" >= ${dayStart}
            AND "timestamp" < ${dayEnd}
            AND "timestamp" < (NOW() - (${retentionCase}))
          ORDER BY id
          LIMIT ${args.limit}
        `.execute(this.kdb)
      : await sql<SecretAuditLogRow>`
          SELECT *
          FROM secret_audit_log
          WHERE routing_key = ${args.tenantId}
            AND archived_at IS NULL
            AND "timestamp" >= ${dayStart}
            AND "timestamp" < ${dayEnd}
            AND "timestamp" < (NOW() - (${retentionCase}))
          ORDER BY id
          LIMIT ${args.limit}
        `.execute(this.kdb);
    for (const r of rows.rows) {
      yield r;
    }
  }

  encodeRow(row: SecretAuditLogRow): string {
    return JSON.stringify(row);
  }

  decodeRow(line: string): SecretAuditLogRow {
    const parsed = JSON.parse(line) as SecretAuditLogRow;
    coerceDate(parsed, 'timestamp');
    coerceDate(parsed, 'archived_at');
    return parsed;
  }

  rowId(row: SecretAuditLogRow): string | number {
    return row.id;
  }

  rowTimestamp(row: SecretAuditLogRow): Date | string {
    return row.timestamp;
  }

  /**
   * Phase 2 — per-row cold-retention TTL. Sampled `resolve` /
   * `resolve_named` rows get 180d cold; mutations get `'forever'`. The
   * denied-outcome override promotes to 730d (forensic).
   *
   * `outcome` is a free-form string in PG but the engine helper only
   * branches on `outcome !== 'allowed'`, so any other value
   * (`'denied'`, `'error'`, future categories) lands in the forensic
   * bucket.
   */
  coldTtlDays(row: SecretAuditLogRow): ColdRetention {
    return getSecretAuditLogColdDays({
      action: row.action,
      outcome: row.outcome === 'allowed' ? 'allowed' : 'denied',
    });
  }

  async markArchivedAndDelete(args: {
    rowIds: ReadonlyArray<string | number>;
    chunkMeta: ChunkCommitMetadata;
  }): Promise<void> {
    if (args.rowIds.length === 0) return;
    const ids = args.rowIds.map(String);
    await this.kdb.transaction().execute(async (trx) => {
      await trx
        .updateTable('secret_audit_log')
        .set({
          archived_at: sql<Date>`now()`,
          archive_object_key: args.chunkMeta.objectKey,
        })
        .where('id', 'in', ids)
        .execute();

      await trx.deleteFrom('secret_audit_log').where('id', 'in', ids).execute();

      // Orchestrator-side audit goes to access_log (mirrors design §8
      // — Platform → audit_log, Orchestrator → access_log).
      await trx
        .insertInto('access_log')
        .values({
          org_id: null,
          routing_key:
            args.chunkMeta.tenantId === SYNTHETIC_ORCH_TENANT ? null : args.chunkMeta.tenantId,
          actor_type: 'system',
          actor_id: `cold-store-archive:${this.instanceId}`,
          actor_meta: null,
          action: 'archive_chunk',
          target_type: this.table,
          target_id: args.chunkMeta.chunkId,
          request_id: null,
          source: 'admin_cli',
          outcome: 'allowed',
          error_message: null,
        })
        .execute();

      await sql`
        INSERT INTO cold_store_chunk_counts
          (db, table_name, tenant_id, chunk_count, total_bytes, total_rows, last_archived_at)
        VALUES
          ('orchestrator', ${this.table}, ${args.chunkMeta.tenantId},
           1, ${args.chunkMeta.gzipByteCount}, ${args.chunkMeta.rowCount}, now())
        ON CONFLICT (db, table_name, tenant_id)
        DO UPDATE SET
          chunk_count      = cold_store_chunk_counts.chunk_count      + 1,
          total_bytes      = cold_store_chunk_counts.total_bytes      + EXCLUDED.total_bytes,
          total_rows       = cold_store_chunk_counts.total_rows       + EXCLUDED.total_rows,
          last_archived_at = now()
      `.execute(trx);

      // Phase 2 — record the chunk in `cold_store_chunks` so the GC
      // sweep can find purge candidates without S3 LIST. Pre-Phase-2
      // (v1) chunks omit `bucket` and are treated as `'forever'`.
      if (args.chunkMeta.bucket !== undefined && args.chunkMeta.maxColdDays !== undefined) {
        const maxColdDaysSerialized = String(args.chunkMeta.maxColdDays);
        await trx
          .insertInto('cold_store_chunks')
          .values({
            db: 'orchestrator',
            table_name: this.table,
            tenant_id: args.chunkMeta.tenantId,
            chunk_id: args.chunkMeta.chunkId,
            bucket: args.chunkMeta.bucket,
            partition_date: args.chunkMeta.partitionDate,
            gzip_bytes: args.chunkMeta.gzipByteCount,
            row_count: args.chunkMeta.rowCount,
            max_cold_days: maxColdDaysSerialized,
            object_key: args.chunkMeta.objectKey,
          })
          .execute();
      }
    });
  }

  async purgeChunkRecord(args: {
    tenantId: string;
    chunkId: string;
    gzipBytes: number;
    rowCount: number;
    bucket: string;
    maxColdDays: number;
    objectKey: string;
  }): Promise<void> {
    await this.kdb.transaction().execute(async (trx) => {
      // 1. Drop the chunk-index row.
      await trx
        .deleteFrom('cold_store_chunks')
        .where('db', '=', 'orchestrator')
        .where('table_name', '=', this.table)
        .where('chunk_id', '=', args.chunkId)
        .execute();

      // 2. Decrement the per-(db, table, tenant) rollup; floor at 0.
      await sql`
        UPDATE cold_store_chunk_counts
        SET chunk_count = GREATEST(chunk_count - 1, 0),
            total_bytes = GREATEST(total_bytes - ${args.gzipBytes}, 0),
            total_rows  = GREATEST(total_rows  - ${args.rowCount}, 0)
        WHERE db = 'orchestrator'
          AND table_name = ${this.table}
          AND tenant_id = ${args.tenantId}
      `.execute(trx);

      // 3. Audit the purge into access_log (orchestrator-side audit
      //    surface — same as the archive_chunk row above).
      await trx
        .insertInto('access_log')
        .values({
          org_id: null,
          routing_key: args.tenantId === SYNTHETIC_ORCH_TENANT ? null : args.tenantId,
          actor_type: 'system',
          actor_id: `cold-store-purge:${this.instanceId}`,
          actor_meta: JSON.stringify({
            tenantId: args.tenantId,
            bucket: args.bucket,
            maxColdDays: args.maxColdDays,
            gzipBytes: args.gzipBytes,
            rowCount: args.rowCount,
            objectKey: args.objectKey,
          }),
          action: 'purge_chunk',
          target_type: this.table,
          target_id: args.chunkId,
          request_id: null,
          source: 'admin_cli',
          outcome: 'allowed',
          error_message: null,
        })
        .execute();
    });
  }
}

function coerceDate<T>(parsed: T, field: keyof T): void {
  const v = (parsed as unknown as Record<string, unknown>)[field as string];
  if (typeof v === 'string') {
    (parsed as unknown as Record<string, unknown>)[field as string] = new Date(v);
  }
}
