import { type Kysely, sql } from 'kysely';

/**
 * Per-run and per-job raw log byte totals, reported by agents on terminal `step.status`.
 *
 * The Platform mirrors these columns via WS replication for its `kici_org_log_bytes` gauge
 * (the DB-derived pattern of `kici_org_executions_count` and `kici_org_agent_minutes`).
 *
 * Default 0 needs no backfill: older runs never had the agent telemetry, so zero is correct.
 * Idempotent.
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
