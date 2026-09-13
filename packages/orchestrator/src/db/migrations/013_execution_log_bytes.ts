import { type Kysely, sql } from 'kysely';

/**
 * Add `log_bytes BIGINT NOT NULL DEFAULT 0` columns to `execution_runs` and
 * `execution_jobs` so the orchestrator can persist the per-job and per-run
 * raw log byte totals reported by agents on terminal `step.status`.
 *
 * Used by the operator-side `kici_org_log_bytes` capacity-planning gauge on
 * the Platform (Platform mirrors these columns via WS replication and runs
 * the aggregation query — same DB-derived pattern as
 * `kici_org_executions_count` and `kici_org_agent_minutes`).
 *
 * Default 0 keeps existing rows valid without a backfill: pre-existing runs
 * predate this column and report as zero log-bytes, which is the correct
 * operator-visibility value (we never had the agent telemetry to compute a
 * real total for them).
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_runs
      ADD COLUMN IF NOT EXISTS log_bytes BIGINT NOT NULL DEFAULT 0
  `.execute(db);

  await sql`
    ALTER TABLE public.execution_jobs
      ADD COLUMN IF NOT EXISTS log_bytes BIGINT NOT NULL DEFAULT 0
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS log_bytes`.execute(db);
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS log_bytes`.execute(db);
}
