import { type Kysely, sql } from 'kysely';

/**
 * Add `workflow_timeout_ms integer` to `execution_runs`.
 *
 * Persists the workflow-level wall-clock timeout (in milliseconds) read from
 * the lock workflow at run creation. NULL means no workflow-level cap is
 * configured. The WorkflowDeadlineDetector reads this column to find runs
 * whose `started_at + workflow_timeout_ms` has passed and cancels them with
 * the distinct workflow-timeout reason.
 *
 * Typed INTEGER to match the existing `*_ms` columns (`duration_ms`,
 * `concurrency_timeout_ms`), which keeps the pg read representation a plain
 * number rather than the BIGINT-as-string shape. INTEGER caps the timeout at
 * ~24.8 days, far beyond any sane workflow wall-clock budget.
 *
 * Idempotent: re-running on a DB that already has the column is a no-op.
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
