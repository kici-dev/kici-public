/**
 * `access_log` cold-store adapter (Orchestrator side).
 *
 * Contract:
 *   - tenant column: `org_id` (NULL → synthetic `__orchestrator__`)
 *   - partition column: `created_at`
 *   - warm TTL: `minAccessLogWarmDays()` table-wide, tightened per row
 *     by `accessLogWarmSqlCase()`
 *   - archived chunks purge per `getAccessLogColdDays()`
 *
 * There is no `expires_at`-based hard delete.
 *
 * Orchestrator-level events (e.g. scheduler tick failures, admin-triggered
 * scheduled jobs) carry `org_id IS NULL` and use the `__orchestrator__` prefix.
 *
 * Recursion: archiving writes one access_log row per chunk, itself archivable
 * later. Volume is bounded — one audit row per ~50K-row chunk.
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  type ChunkCommitMetadata,
  type ColdRetention,
  type ColdStoreTableConfig,
  type EligiblePartition,
  type TableAdapter,
  PgTableAdapterBase,
} from '@kici-dev/shared';
import {
  type AccessLogAction,
  type AccessLogOutcome,
  type ActorType,
  accessLogWarmSqlCase,
  getAccessLogColdDays,
  minAccessLogWarmDays,
} from '@kici-dev/engine';
import type { AccessLogTable, Database } from '../../db/types.js';
import { SYNTHETIC_ORCH_TENANT } from '../load-access-log-range.js';

export type AccessLogColdStoreRow = Selectable<AccessLogTable>;

const ADVISORY_LOCK_NAMESPACE = 'cold-store|orchestrator|access_log';
const APPROX_ROW_BYTES = 500;

/**
 * `warmTtlDays` MUST equal `minAccessLogWarmDays()` so the index-friendly
 * partition scan (`created_at < warmCutoff`) never drops rows the per-row CASE
 * in `accessLogWarmSqlCase()` (by action / outcome / actor_type) would archive.
 */
const DEFAULT_CONFIG: ColdStoreTableConfig = {
  warmTtlDays: minAccessLogWarmDays(),
  minWarmTenantBytes: 1 * 1024 * 1024,
  minChunkBytes: 1 * 1024 * 1024,
  maxChunkBytes: 50 * 1024 * 1024,
  maxRowsPerCycle: 50_000,
  enabled: true,
};

export interface AccessLogAdapterOptions {
  overrides?: Partial<ColdStoreTableConfig>;
}

export class AccessLogAdapter
  extends PgTableAdapterBase<Database>
  implements TableAdapter<AccessLogColdStoreRow>
{
  readonly db = 'orchestrator' as const;
  readonly table = 'access_log';
  readonly tenantColumn = 'org_id';
  readonly partitionColumn = 'created_at';

  constructor(
    kdb: Kysely<Database>,
    private readonly instanceId: string,
    opts: AccessLogAdapterOptions = {},
  ) {
    super(kdb, ADVISORY_LOCK_NAMESPACE, DEFAULT_CONFIG, opts.overrides);
  }

  async *listEligiblePartitions(args: { warmCutoff: Date }): AsyncIterable<EligiblePartition> {
    // access_log_org_created_idx (org_id, created_at DESC) serves this scan.
    // `sql.lit` inlines the literal so the SELECT and GROUP BY COALESCE match;
    // a bound parameter yields two distinct $N placeholders and PG rejects it.
    // `retentionCase` skips partitions whose rows' category TTL has not elapsed.
    const synthetic = sql.lit(SYNTHETIC_ORCH_TENANT);
    const retentionCase = sql.raw(accessLogWarmSqlCase());
    const rows = await sql<{ tenant_id: string; partition_date: string }>`
      SELECT COALESCE(org_id, ${synthetic}) AS tenant_id,
             TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS partition_date
      FROM access_log
      WHERE created_at < ${args.warmCutoff}
        AND created_at < (NOW() - (${retentionCase}))
      GROUP BY COALESCE(org_id, ${synthetic}), DATE(created_at)
      ORDER BY tenant_id, partition_date
    `.execute(this.kdb);
    for (const r of rows.rows) {
      yield { tenantId: r.tenant_id, partitionDate: r.partition_date };
    }
  }

  async countTenantWarmBytes(args: { tenantId: string; warmCutoff: Date }): Promise<number> {
    const isSynthetic = args.tenantId === SYNTHETIC_ORCH_TENANT;
    const retentionCase = sql.raw(accessLogWarmSqlCase());
    const res = isSynthetic
      ? await sql<{ n: string }>`
          SELECT COUNT(*)::text AS n
          FROM access_log
          WHERE org_id IS NULL
            AND created_at < ${args.warmCutoff}
            AND created_at < (NOW() - (${retentionCase}))
        `.execute(this.kdb)
      : await sql<{ n: string }>`
          SELECT COUNT(*)::text AS n
          FROM access_log
          WHERE org_id = ${args.tenantId}
            AND created_at < ${args.warmCutoff}
            AND created_at < (NOW() - (${retentionCase}))
        `.execute(this.kdb);
    const n = Number(res.rows[0]?.n ?? '0');
    return Number.isFinite(n) ? n * APPROX_ROW_BYTES : 0;
  }

  async *selectEligible(args: {
    tenantId: string;
    partitionDate: string;
    limit: number;
  }): AsyncIterable<AccessLogColdStoreRow> {
    const dayStart = new Date(`${args.partitionDate}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const isSynthetic = args.tenantId === SYNTHETIC_ORCH_TENANT;
    const retentionCase = sql.raw(accessLogWarmSqlCase());
    const rows = isSynthetic
      ? await sql<AccessLogColdStoreRow>`
          SELECT *
          FROM access_log
          WHERE org_id IS NULL
            AND archived_at IS NULL
            AND created_at >= ${dayStart}
            AND created_at < ${dayEnd}
            AND created_at < (NOW() - (${retentionCase}))
          ORDER BY id
          LIMIT ${args.limit}
        `.execute(this.kdb)
      : await sql<AccessLogColdStoreRow>`
          SELECT *
          FROM access_log
          WHERE org_id = ${args.tenantId}
            AND archived_at IS NULL
            AND created_at >= ${dayStart}
            AND created_at < ${dayEnd}
            AND created_at < (NOW() - (${retentionCase}))
          ORDER BY id
          LIMIT ${args.limit}
        `.execute(this.kdb);
    for (const r of rows.rows) {
      yield r;
    }
  }

  encodeRow(row: AccessLogColdStoreRow): string {
    return JSON.stringify(row);
  }

  decodeRow(line: string): AccessLogColdStoreRow {
    const parsed = JSON.parse(line) as AccessLogColdStoreRow;
    PgTableAdapterBase.coerceDate(parsed, 'created_at');
    PgTableAdapterBase.coerceDate(parsed, 'archived_at');
    return parsed;
  }

  rowId(row: AccessLogColdStoreRow): string | number {
    return row.id;
  }

  rowTimestamp(row: AccessLogColdStoreRow): Date | string {
    return row.created_at;
  }

  /**
   * Per-row cold-retention TTL, mirroring the warm-side layering:
   * outcome=denied/error → 730d (forensic), platform_operator → `'forever'`
   * (compliance), otherwise the per-action map. Archive buckets rows by
   * `coldDaysToBucket(coldTtlDays(row))`.
   */
  coldTtlDays(row: AccessLogColdStoreRow): ColdRetention {
    return getAccessLogColdDays({
      action: row.action as AccessLogAction,
      outcome: row.outcome as AccessLogOutcome,
      actorType: row.actor_type as ActorType,
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
        .updateTable('access_log')
        .set({
          archived_at: sql<Date>`now()`,
          archive_object_key: args.chunkMeta.objectKey,
        })
        .where('id', 'in', ids)
        .execute();

      await trx.deleteFrom('access_log').where('id', 'in', ids).execute();

      // Recursive write: one access_log row per chunk, archived in a later cycle.
      await trx
        .insertInto('access_log')
        .values({
          org_id:
            args.chunkMeta.tenantId === SYNTHETIC_ORCH_TENANT ? null : args.chunkMeta.tenantId,
          routing_key: null,
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

      // Index the chunk so the GC sweep finds purge candidates without S3 LIST.
      // Only per-bucket (v2 manifest) chunks get a row; v1 chunks omit `bucket`
      // and are treated as `'forever'`.
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

      // Floor the rollup at 0 in case it drifted (e.g. a manual delete from
      // cold_store_chunks).
      await sql`
        UPDATE cold_store_chunk_counts
        SET chunk_count = GREATEST(chunk_count - 1, 0),
            total_bytes = GREATEST(total_bytes - ${args.gzipBytes}, 0),
            total_rows  = GREATEST(total_rows  - ${args.rowCount}, 0)
        WHERE db = 'orchestrator'
          AND table_name = ${this.table}
          AND tenant_id = ${args.tenantId}
      `.execute(trx);

      // Audit the purge, as archive_chunk does above.
      await trx
        .insertInto('access_log')
        .values({
          org_id: args.tenantId === SYNTHETIC_ORCH_TENANT ? null : args.tenantId,
          routing_key: null,
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
