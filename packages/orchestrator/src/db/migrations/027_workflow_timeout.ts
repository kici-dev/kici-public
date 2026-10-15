import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.workflow_timeout_ms`: the lock workflow's wall-clock timeout (ms), read at
 * run creation; NULL means no cap. The WorkflowDeadlineDetector cancels runs past
 * `started_at + workflow_timeout_ms` with the distinct workflow-timeout reason.
 *
 * INTEGER like the other `*_ms` columns, so pg reads a plain number rather than a BIGINT string;
 * it caps the timeout at ~24.8 days. Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_runs
      ADD COLUMN IF NOT EXISTS workflow_timeout_ms INTEGER DEFAULT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS workflow_timeout_ms
  `.execute(db);
}
