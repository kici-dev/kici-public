/**
 * `execution_runs` cold-store adapter (Orchestrator side).
 *
 *
 * Contract:
 *   - tenant column: `routing_key`
 *   - partition column: `created_at`
 *   - warm TTL: 30 days (design §5 matrix row 7)
 *   - eligibility: terminal run status AND no live jobs reference this run
 *
 * Order: registered LAST in the orchestrator cold-store. Within one
 * cycle the framework iterates adapters steps → jobs → runs; this
 * adapter goes last so the FK `execution_jobs.run_id →
 * execution_runs(run_id)` doesn't fire on DELETE. The "no live jobs"
 * predicate enforces the same invariant across cycle interruptions.
 */
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  type ChunkCommitMetadata,
  type ColdStoreTableConfig,
  type EligiblePartition,
  type TableAdapter,
} from '@kici-dev/shared';
import { TERMINAL_RUN_STATES } from '@kici-dev/engine';
import type { Database, ExecutionRunTable } from '../../db/types.js';

export type ExecutionRunRow = Selectable<ExecutionRunTable>;

const ADVISORY_LOCK_NAMESPACE = 'cold-store|orchestrator|execution_runs';
const APPROX_ROW_BYTES = 1000;

const TERMINAL_STATUS_LIST: readonly string[] = Array.from(TERMINAL_RUN_STATES);

/** Per-table defaults (design §5 matrix row 7). */
const DEFAULT_CONFIG: ColdStoreTableConfig = {
  warmTtlDays: 30,
  minWarmTenantBytes: 5 * 1024 * 1024,
  minChunkBytes: 1 * 1024 * 1024,
  maxChunkBytes: 50 * 1024 * 1024,
  maxRowsPerCycle: 50_000,
  enabled: true,
};

export interface ExecutionRunsAdapterOptions {
  overrides?: Partial<ColdStoreTableConfig>;
}

export class ExecutionRunsAdapter implements TableAdapter<ExecutionRunRow> {
  readonly db = 'orchestrator' as const;
  readonly table = 'execution_runs';
  readonly tenantColumn = 'routing_key';
  readonly partitionColumn = 'created_at';
  readonly config: ColdStoreTableConfig;

  constructor(
    private readonly kdb: Kysely<Database>,
    private readonly instanceId: string,
    opts: ExecutionRunsAdapterOptions = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...(opts.overrides ?? {}) };
  }

  async *listEligiblePartitions(args: { warmCutoff: Date }): AsyncIterable<EligiblePartition> {
    const rows = await sql<{ tenant_id: string; partition_date: string }>`
      SELECT routing_key AS tenant_id,
             TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS partition_date
      FROM execution_runs
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
      FROM execution_runs
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
  }): AsyncIterable<ExecutionRunRow> {
    const dayStart = new Date(`${args.partitionDate}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    // FK guard: skip runs that still have live `execution_jobs` rows.
    // The FK `execution_jobs.run_id → execution_runs(run_id)` would
    // abort the DELETE otherwise; this predicate makes the adapter
    // safe across cycle interruptions.
    const rows = await sql<ExecutionRunRow>`
      SELECT *
      FROM execution_runs r
      WHERE r.routing_key = ${args.tenantId}
        AND r.created_at >= ${dayStart}
        AND r.created_at < ${dayEnd}
        AND r.status = ANY(${TERMINAL_STATUS_LIST})
        AND NOT EXISTS (
          SELECT 1 FROM execution_jobs j WHERE j.run_id = r.run_id
        )
      ORDER BY r.id
      LIMIT ${args.limit}
    `.execute(this.kdb);
    for (const r of rows.rows) {
      yield r;
    }
  }

  encodeRow(row: ExecutionRunRow): string {
    return JSON.stringify(row);
  }

  decodeRow(line: string): ExecutionRunRow {
    const parsed = JSON.parse(line) as ExecutionRunRow;
    coerceDate(parsed, 'created_at');
    coerceDate(parsed, 'started_at');
    coerceDate(parsed, 'completed_at');
    coerceDate(parsed, 'archived_at');
    return parsed;
  }

  rowId(row: ExecutionRunRow): string | number {
    return row.id;
  }

  rowTimestamp(row: ExecutionRunRow): Date | string {
    return row.created_at;
  }

  /**
   * Phase F — natural-key extractor used by `replayRow` so callers
   * (the rerun pipeline) can locate the chunk holding a given UUID
   * `run_id` without knowing the internal SERIAL `id` returned by
   * `rowId()`.
   */
  replayLookupKey(row: ExecutionRunRow): string {
    return row.run_id;
  }

  /**
   * Phase F — replay a chunk's `execution_runs` rows back into
   * Orchestrator PG. Mirrors the Platform-side replayInsert; the
   * audit row goes to `access_log` (not `audit_log`) because the
   * orchestrator's audit surface is access_log per design §8.
   *
   * Idempotent on duplicate replays via `ON CONFLICT (run_id) DO
   * NOTHING`. Decrements `cold_store_chunk_counts` (floored at 0).
   */
  async replayInsert(args: {
    rows: ReadonlyArray<ExecutionRunRow>;
    chunkMeta: ChunkCommitMetadata;
  }): Promise<{ inserted: number; skipped: number }> {
    if (args.rows.length === 0) return { inserted: 0, skipped: 0 };
    let inserted = 0;
    await this.kdb.transaction().execute(async (trx) => {
      for (const raw of args.rows) {
        const row = { ...raw, archived_at: null, archive_object_key: null };
        const res = await trx
          .insertInto('execution_runs')
          .values(row)
          .onConflict((oc) => oc.column('run_id').doNothing())
          .executeTakeFirst();
        if (Number(res.numInsertedOrUpdatedRows ?? 0n) > 0) inserted += 1;
      }

      await trx
        .insertInto('access_log')
        .values({
          org_id: null,
          routing_key: args.chunkMeta.tenantId,
          actor_type: 'system',
          actor_id: `cold-store-replay:${this.instanceId}`,
          actor_meta: null,
          action: 'replay_chunk',
          target_type: 'run',
          target_id: args.chunkMeta.chunkId,
          request_id: null,
          source: 'admin_cli',
          outcome: 'allowed',
          error_message: null,
        })
        .execute();

      await sql`
        UPDATE cold_store_chunk_counts
        SET chunk_count      = GREATEST(chunk_count - 1, 0),
            total_rows       = GREATEST(total_rows  - ${inserted}, 0),
            total_bytes      = GREATEST(total_bytes - ${args.chunkMeta.gzipByteCount}, 0)
        WHERE db = 'orchestrator'
          AND table_name = ${this.table}
          AND tenant_id  = ${args.chunkMeta.tenantId}
      `.execute(trx);
    });
    return { inserted, skipped: args.rows.length - inserted };
  }

  async markArchivedAndDelete(args: {
    rowIds: ReadonlyArray<string | number>;
    chunkMeta: ChunkCommitMetadata;
  }): Promise<void> {
    if (args.rowIds.length === 0) return;
    const ids = args.rowIds.map(String);
    await this.kdb.transaction().execute(async (trx) => {
      await trx
        .updateTable('execution_runs')
        .set({
          archived_at: sql<Date>`now()`,
          archive_object_key: args.chunkMeta.objectKey,
        })
        .where('id', 'in', ids)
        .execute();

      await trx.deleteFrom('execution_runs').where('id', 'in', ids).execute();

      await trx
        .insertInto('access_log')
        .values({
          org_id: null,
          routing_key: args.chunkMeta.tenantId,
          actor_type: 'system',
          actor_id: `cold-store-archive:${this.instanceId}`,
          actor_meta: null,
          action: 'archive_chunk',
          target_type: 'run',
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
