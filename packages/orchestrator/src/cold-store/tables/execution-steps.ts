/**
 * `execution_steps` cold-store adapter (Orchestrator side).
 *
 *
 * Contract:
 *   - tenant column: `routing_key` (denormalized in migration 006)
 *   - partition column: `created_at`
 *   - warm TTL: 30 days (design §5 matrix row 9)
 *   - eligibility: created_at < cutoff (steps are append-only and have no
 *     terminal-status predicate — there is no UPDATE statement against
 *     `execution_steps` in the orchestrator codebase, so age alone is
 *     sufficient)
 *
 * Order: registered FIRST in the orchestrator cold-store. Within one
 * cycle the framework iterates adapters in registration order
 * (steps → jobs → runs); steps go first so the FK chain
 * (execution_jobs.run_id → execution_runs.run_id) doesn't break when
 * jobs and runs are archived later.
 *
 * Audit emission: orchestrator-side adapters write to `access_log`
 * (the orchestrator's audit surface; `audit_log` is Platform-side only).
 * The row uses actor_type='system', actor_id='cold-store-archive:<id>'.
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  type ChunkCommitMetadata,
  type ColdStoreTableConfig,
  type EligiblePartition,
  type TableAdapter,
} from '@kici-dev/shared';
import type { Database, ExecutionStepTable } from '../../db/types.js';

export type ExecutionStepRow = Selectable<ExecutionStepTable>;

const ADVISORY_LOCK_NAMESPACE = 'cold-store|orchestrator|execution_steps';
const APPROX_ROW_BYTES = 600;

/** Per-table defaults (design §5 matrix row 9). */
const DEFAULT_CONFIG: ColdStoreTableConfig = {
  warmTtlDays: 30,
  minWarmTenantBytes: 10 * 1024 * 1024,
  minChunkBytes: 5 * 1024 * 1024,
  maxChunkBytes: 100 * 1024 * 1024,
  maxRowsPerCycle: 500_000,
  enabled: true,
};

export interface ExecutionStepsAdapterOptions {
  overrides?: Partial<ColdStoreTableConfig>;
}

export class ExecutionStepsAdapter implements TableAdapter<ExecutionStepRow> {
  readonly db = 'orchestrator' as const;
  readonly table = 'execution_steps';
  readonly tenantColumn = 'routing_key';
  readonly partitionColumn = 'created_at';
  readonly config: ColdStoreTableConfig;

  constructor(
    private readonly kdb: Kysely<Database>,
    private readonly instanceId: string,
    opts: ExecutionStepsAdapterOptions = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...(opts.overrides ?? {}) };
  }

  async *listEligiblePartitions(args: { warmCutoff: Date }): AsyncIterable<EligiblePartition> {
    // routing_key IS NOT NULL — rows without a denormalized tenant are
    // skipped (e.g. ancient rows that never got backfilled). The
    // backfill in migration 006 populates everything that has a parent
    // run; orphans without a parent run can't be archived because we
    // don't know their tenant.
    const rows = await sql<{ tenant_id: string; partition_date: string }>`
      SELECT routing_key AS tenant_id,
             TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS partition_date
      FROM execution_steps
      WHERE created_at < ${args.warmCutoff}
        AND routing_key IS NOT NULL
      GROUP BY routing_key, DATE(created_at)
      ORDER BY routing_key, DATE(created_at)
    `.execute(this.kdb);
    for (const r of rows.rows) {
      yield { tenantId: r.tenant_id, partitionDate: r.partition_date };
    }
  }

  async countTenantWarmBytes(args: { tenantId: string; warmCutoff: Date }): Promise<number> {
    const res = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n
      FROM execution_steps
      WHERE routing_key = ${args.tenantId}
        AND created_at < ${args.warmCutoff}
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
  }): AsyncIterable<ExecutionStepRow> {
    const dayStart = new Date(`${args.partitionDate}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const rows = await this.kdb
      .selectFrom('execution_steps')
      .selectAll()
      .where('routing_key', '=', args.tenantId)
      .where('created_at', '>=', dayStart)
      .where('created_at', '<', dayEnd)
      .orderBy('id')
      .limit(args.limit)
      .execute();
    for (const r of rows) {
      yield r;
    }
  }

  encodeRow(row: ExecutionStepRow): string {
    return JSON.stringify(row);
  }

  decodeRow(line: string): ExecutionStepRow {
    const parsed = JSON.parse(line) as ExecutionStepRow;
    coerceDate(parsed, 'created_at');
    coerceDate(parsed, 'started_at');
    coerceDate(parsed, 'completed_at');
    coerceDate(parsed, 'archived_at');
    return parsed;
  }

  rowId(row: ExecutionStepRow): string | number {
    return row.id;
  }

  rowTimestamp(row: ExecutionStepRow): Date | string {
    return row.created_at;
  }

  async markArchivedAndDelete(args: {
    rowIds: ReadonlyArray<string | number>;
    chunkMeta: ChunkCommitMetadata;
  }): Promise<void> {
    if (args.rowIds.length === 0) return;
    const ids = args.rowIds.map(String);
    await this.kdb.transaction().execute(async (trx) => {
      await trx
        .updateTable('execution_steps')
        .set({
          archived_at: sql<Date>`now()`,
          archive_object_key: args.chunkMeta.objectKey,
        })
        .where('id', 'in', ids)
        .execute();

      await trx.deleteFrom('execution_steps').where('id', 'in', ids).execute();

      // Orchestrator-side audit: access_log (mirrors design §8 split —
      // Platform writes to audit_log, Orchestrator writes to access_log).
      await trx
        .insertInto('access_log')
        .values({
          org_id: null,
          routing_key: args.chunkMeta.tenantId,
          actor_type: 'system',
          actor_id: `cold-store-archive:${this.instanceId}`,
          actor_meta: null,
          action: 'archive_chunk',
          target_type: 'step',
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

function coerceDate<T>(parsed: T, field: keyof T): void {
  const v = (parsed as unknown as Record<string, unknown>)[field as string];
  if (typeof v === 'string') {
    (parsed as unknown as Record<string, unknown>)[field as string] = new Date(v);
  }
}
