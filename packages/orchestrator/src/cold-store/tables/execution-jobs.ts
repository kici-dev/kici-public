/**
 * `execution_jobs` cold-store adapter (Orchestrator side).
 *
 *
 * Contract:
 *   - tenant column: `routing_key` (denormalized in migration 006)
 *   - partition column: `created_at`
 *   - warm TTL: 30 days (design §5 matrix row 8)
 *   - eligibility: terminal job status AND no live steps remain for this
 *     (run, job)
 *
 * Order: registered AFTER `ExecutionStepsAdapter`, BEFORE
 * `ExecutionRunsAdapter` (within one cycle: steps → jobs → runs). The
 * "no live steps" predicate makes the ordering self-correcting across
 * cycle interruptions.
 *
 * FK ordering on the orchestrator side: `execution_jobs.run_id` is a
 * FK to `execution_runs(run_id)`. Deleting a job is safe from the FK's
 * perspective (the FK only constrains job → run direction). The runs
 * adapter's eligibility predicate handles the dependent-rows check.
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  type ChunkCommitMetadata,
  type ColdStoreTableConfig,
  type EligiblePartition,
  type TableAdapter,
} from '@kici-dev/shared';
import { TERMINAL_JOB_STATES } from '@kici-dev/engine';
import type { Database, ExecutionJobTable } from '../../db/types.js';

export type ExecutionJobRow = Selectable<ExecutionJobTable>;

const ADVISORY_LOCK_NAMESPACE = 'cold-store|orchestrator|execution_jobs';
const APPROX_ROW_BYTES = 1500;

const TERMINAL_STATUS_LIST: readonly string[] = Array.from(TERMINAL_JOB_STATES);

/** Per-table defaults (design §5 matrix row 8). */
const DEFAULT_CONFIG: ColdStoreTableConfig = {
  warmTtlDays: 30,
  minWarmTenantBytes: 5 * 1024 * 1024,
  minChunkBytes: 1 * 1024 * 1024,
  maxChunkBytes: 50 * 1024 * 1024,
  maxRowsPerCycle: 100_000,
  enabled: true,
};

export interface ExecutionJobsAdapterOptions {
  overrides?: Partial<ColdStoreTableConfig>;
}

export class ExecutionJobsAdapter implements TableAdapter<ExecutionJobRow> {
  readonly db = 'orchestrator' as const;
  readonly table = 'execution_jobs';
  readonly tenantColumn = 'routing_key';
  readonly partitionColumn = 'created_at';
  readonly config: ColdStoreTableConfig;

  constructor(
    private readonly kdb: Kysely<Database>,
    private readonly instanceId: string,
    opts: ExecutionJobsAdapterOptions = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...(opts.overrides ?? {}) };
  }

  async *listEligiblePartitions(args: { warmCutoff: Date }): AsyncIterable<EligiblePartition> {
    const rows = await sql<{ tenant_id: string; partition_date: string }>`
      SELECT routing_key AS tenant_id,
             TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS partition_date
      FROM execution_jobs
      WHERE created_at < ${args.warmCutoff}
        AND status = ANY(${TERMINAL_STATUS_LIST})
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
      FROM execution_jobs
      WHERE routing_key = ${args.tenantId}
        AND created_at < ${args.warmCutoff}
        AND status = ANY(${TERMINAL_STATUS_LIST})
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
  }): AsyncIterable<ExecutionJobRow> {
    const dayStart = new Date(`${args.partitionDate}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    // Defensive predicate: skip jobs that still have live step rows in PG.
    // Within a single cycle the steps adapter runs first and clears them;
    // across interrupted cycles, this skip ensures we don't archive a job
    // that has surviving steps (which would orphan the steps from their
    // parent metadata).
    const rows = await sql<ExecutionJobRow>`
      SELECT *
      FROM execution_jobs j
      WHERE j.routing_key = ${args.tenantId}
        AND j.created_at >= ${dayStart}
        AND j.created_at < ${dayEnd}
        AND j.status = ANY(${TERMINAL_STATUS_LIST})
        AND NOT EXISTS (
          SELECT 1 FROM execution_steps s
          WHERE s.run_id = j.run_id
            AND s.job_id = j.job_id
        )
      ORDER BY j.id
      LIMIT ${args.limit}
    `.execute(this.kdb);
    for (const r of rows.rows) {
      yield r;
    }
  }

  encodeRow(row: ExecutionJobRow): string {
    return JSON.stringify(row);
  }

  decodeRow(line: string): ExecutionJobRow {
    const parsed = JSON.parse(line) as ExecutionJobRow;
    coerceDate(parsed, 'created_at');
    coerceDate(parsed, 'started_at');
    coerceDate(parsed, 'completed_at');
    coerceDate(parsed, 'last_heartbeat_at');
    coerceDate(parsed, 'ready_at');
    coerceDate(parsed, 'archived_at');
    return parsed;
  }

  rowId(row: ExecutionJobRow): string | number {
    return row.id;
  }

  rowTimestamp(row: ExecutionJobRow): Date | string {
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
        .updateTable('execution_jobs')
        .set({
          archived_at: sql<Date>`now()`,
          archive_object_key: args.chunkMeta.objectKey,
        })
        .where('id', 'in', ids)
        .execute();

      await trx.deleteFrom('execution_jobs').where('id', 'in', ids).execute();

      await trx
        .insertInto('access_log')
        .values({
          org_id: null,
          routing_key: args.chunkMeta.tenantId,
          actor_type: 'system',
          actor_id: `cold-store-archive:${this.instanceId}`,
          actor_meta: null,
          action: 'archive_chunk',
          target_type: 'job',
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
