/**
 * `secret_audit_log` cold-store adapter (Orchestrator side).
 *
 * Contract:
 *   - tenant column: `routing_key` (NULL → synthetic `__orchestrator__`)
 *   - partition column: `timestamp`
 *   - warm TTL: `minSecretAuditLogWarmDays()` table-wide, tightened per row
 *     by `secretAuditLogWarmSqlCase()`
 *
 * Rows without `routing_key` (e.g. key rotations before any source is bound) collapse to the
 * synthetic prefix `__orchestrator__`, the pattern `event_log` payload keys use too.
 */
import { sql, type Kysely } from 'kysely';
import {
  type ChunkCommitMetadata,
  type ColdRetention,
  type ColdStoreTableConfig,
  type EligiblePartition,
  type TableAdapter,
  PgTableAdapterBase,
} from '@kici-dev/shared';
import {
  getSecretAuditLogColdDays,
  minSecretAuditLogWarmDays,
  secretAuditLogWarmSqlCase,
} from '@kici-dev/engine';
import type { Database, SecretAuditLogRow } from '../../db/types.js';

/** Re-exported rather than re-declared — see the note in `load-event-log-range`. */
export type { SecretAuditLogRow };
import { SYNTHETIC_ORCH_TENANT } from '../load-access-log-range.js';

const ADVISORY_LOCK_NAMESPACE = 'cold-store|orchestrator|secret_audit_log';
const APPROX_ROW_BYTES = 400;

/**
 * `warmTtlDays` MUST equal `minSecretAuditLogWarmDays()`, so the index-friendly partition scan
 * does not pre-filter rows the per-row CASE in `secretAuditLogWarmSqlCase()` deems eligible.
 * The CASE tightens per action / outcome: sampled `resolve` / `resolve_named` rows archive at
 * 30d (the post-sampling 1% volume), mutations stay 365d.
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

export class SecretAuditLogAdapter
  extends PgTableAdapterBase<Database>
  implements TableAdapter<SecretAuditLogRow>
{
  readonly db = 'orchestrator' as const;
  readonly table = 'secret_audit_log';
  readonly tenantColumn = 'routing_key';
  readonly partitionColumn = 'timestamp';

  constructor(
    kdb: Kysely<Database>,
    private readonly instanceId: string,
    opts: SecretAuditLogAdapterOptions = {},
  ) {
    super(kdb, ADVISORY_LOCK_NAMESPACE, DEFAULT_CONFIG, opts.overrides);
  }

  async *listEligiblePartitions(args: { warmCutoff: Date }): AsyncIterable<EligiblePartition> {
    // `idx_secret_audit_log_routing_timestamp` (migration 007) makes this scan cheap. `sql.lit`
    // inlines the synthetic tenant so SELECT and GROUP BY are identical expressions: two bound
    // $N placeholders would make PG reject routing_key as missing from the GROUP BY.
    //
    // `retentionCase` tightens `< warmCutoff`, so mutation-only (365d) partitions are not
    // yielded once the 30d minimum cutoff passes.
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
    PgTableAdapterBase.coerceDate(parsed, 'timestamp');
    PgTableAdapterBase.coerceDate(parsed, 'archived_at');
    return parsed;
  }

  rowId(row: SecretAuditLogRow): string | number {
    return row.id;
  }

  rowTimestamp(row: SecretAuditLogRow): Date | string {
    return row.timestamp;
  }

  /**
   * Sampled `resolve` / `resolve_named` rows get 180d cold; mutations get `'forever'`; a
   * denied outcome promotes to 730d (forensic). `outcome` is free-form in PG, so any value
   * other than `'allowed'` (`'error'`, future categories) lands in the forensic bucket.
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

      // `cold_store_chunks` lets the GC sweep find purge candidates without S3 LIST. V1 chunks
      // omit `bucket` and are treated as `'forever'`.
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
      await trx
        .deleteFrom('cold_store_chunks')
        .where('db', '=', 'orchestrator')
        .where('table_name', '=', this.table)
        .where('chunk_id', '=', args.chunkId)
        .execute();

      // Floor the rollup at 0.
      await sql`
        UPDATE cold_store_chunk_counts
        SET chunk_count = GREATEST(chunk_count - 1, 0),
            total_bytes = GREATEST(total_bytes - ${args.gzipBytes}, 0),
            total_rows  = GREATEST(total_rows  - ${args.rowCount}, 0)
        WHERE db = 'orchestrator'
          AND table_name = ${this.table}
          AND tenant_id = ${args.tenantId}
      `.execute(trx);

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
