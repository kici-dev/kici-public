/**
 * `event_log` cold-store adapter (Orchestrator side).
 *
 * Contract:
 *   - tenant column: `routing_key` (NOT NULL on this side — no
 *     synthetic-tenant fallback like access_log / secret_audit_log)
 *   - partition column: `received_at`
 *   - warm TTL: 30 days (rows are archived, not hard-deleted)
 *
 * Each row's `payload_key` points at a gzipped webhook body in object
 * storage. Archiving moves the row, `payload_key` included, and leaves the
 * body where it is, so the delivery-detail page reads payloads the same way
 * for hot and cold rows.
 *
 * Each archived chunk writes one `access_log` audit row, which the
 * AccessLogAdapter archives in a later cycle.
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  type ChunkCommitMetadata,
  type ColdStoreTableConfig,
  type EligiblePartition,
  type TableAdapter,
  PgTableAdapterBase,
} from '@kici-dev/shared';
import type { Database, EventLogTable } from '../../db/types.js';

export type EventLogColdStoreRow = Selectable<EventLogTable>;

const ADVISORY_LOCK_NAMESPACE = 'cold-store|orchestrator|event_log';
/** Approximate per-row bytes for the minWarmTenantBytes floor check. */
const APPROX_ROW_BYTES = 800;

const DEFAULT_CONFIG: ColdStoreTableConfig = {
  warmTtlDays: 30,
  minWarmTenantBytes: 5 * 1024 * 1024,
  minChunkBytes: 1 * 1024 * 1024,
  maxChunkBytes: 50 * 1024 * 1024,
  maxRowsPerCycle: 50_000,
  enabled: true,
};

export interface EventLogAdapterOptions {
  overrides?: Partial<ColdStoreTableConfig>;
}

export class EventLogAdapter
  extends PgTableAdapterBase<Database>
  implements TableAdapter<EventLogColdStoreRow>
{
  readonly db = 'orchestrator' as const;
  readonly table = 'event_log';
  readonly tenantColumn = 'routing_key';
  readonly partitionColumn = 'received_at';

  constructor(
    kdb: Kysely<Database>,
    private readonly instanceId: string,
    opts: EventLogAdapterOptions = {},
  ) {
    super(kdb, ADVISORY_LOCK_NAMESPACE, DEFAULT_CONFIG, opts.overrides);
  }

  async *listEligiblePartitions(args: { warmCutoff: Date }): AsyncIterable<EligiblePartition> {
    // `idx_event_log_routing_received` (migration 008) makes the GROUP BY cheap.
    const rows = await sql<{ tenant_id: string; partition_date: string }>`
      SELECT routing_key AS tenant_id,
             TO_CHAR(DATE(received_at), 'YYYY-MM-DD') AS partition_date
      FROM event_log
      WHERE received_at < ${args.warmCutoff}
      GROUP BY routing_key, DATE(received_at)
      ORDER BY routing_key, DATE(received_at)
    `.execute(this.kdb);
    for (const r of rows.rows) {
      yield { tenantId: r.tenant_id, partitionDate: r.partition_date };
    }
  }

  async countTenantWarmBytes(args: { tenantId: string; warmCutoff: Date }): Promise<number> {
    const res = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n
      FROM event_log
      WHERE routing_key = ${args.tenantId}
        AND received_at < ${args.warmCutoff}
    `.execute(this.kdb);
    const n = Number(res.rows[0]?.n ?? '0');
    return Number.isFinite(n) ? n * APPROX_ROW_BYTES : 0;
  }

  async *selectEligible(args: {
    tenantId: string;
    partitionDate: string;
    limit: number;
  }): AsyncIterable<EventLogColdStoreRow> {
    const dayStart = new Date(`${args.partitionDate}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const rows = await this.kdb
      .selectFrom('event_log')
      .selectAll()
      .where('routing_key', '=', args.tenantId)
      .where('received_at', '>=', dayStart)
      .where('received_at', '<', dayEnd)
      .where('archived_at', 'is', null)
      .orderBy('id')
      .limit(args.limit)
      .execute();
    for (const r of rows) {
      yield r;
    }
  }

  encodeRow(row: EventLogColdStoreRow): string {
    return JSON.stringify(row);
  }

  decodeRow(line: string): EventLogColdStoreRow {
    const parsed = JSON.parse(line) as EventLogColdStoreRow;
    PgTableAdapterBase.coerceDate(parsed, 'received_at');
    PgTableAdapterBase.coerceDate(parsed, 'archived_at');
    return parsed;
  }

  rowId(row: EventLogColdStoreRow): string | number {
    return row.id;
  }

  rowTimestamp(row: EventLogColdStoreRow): Date | string {
    return row.received_at;
  }

  async markArchivedAndDelete(args: {
    rowIds: ReadonlyArray<string | number>;
    chunkMeta: ChunkCommitMetadata;
  }): Promise<void> {
    if (args.rowIds.length === 0) return;
    const ids = args.rowIds.map(String);
    await this.kdb.transaction().execute(async (trx) => {
      await trx
        .updateTable('event_log')
        .set({
          archived_at: sql<Date>`now()`,
          archive_object_key: args.chunkMeta.objectKey,
        })
        .where('id', 'in', ids)
        .execute();

      await trx.deleteFrom('event_log').where('id', 'in', ids).execute();

      await trx
        .insertInto('access_log')
        .values({
          org_id: null,
          routing_key: args.chunkMeta.tenantId,
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
    });
  }
}
