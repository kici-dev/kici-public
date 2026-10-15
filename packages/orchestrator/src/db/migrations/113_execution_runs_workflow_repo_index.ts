import { type Kysely, sql } from 'kysely';

/**
 * Add the partial index `idx_execution_runs_workflow_repo` on
 * `execution_runs (workflow_repo_identifier) WHERE workflow_repo_identifier IS NOT NULL`.
 *
 * Registration-to-run matching keys on the repository that defines the workflow
 * (`registration/registration-run-match.ts`):
 * `workflow_repo_identifier IN (…) OR (workflow_repo_identifier IS NULL AND repo_identifier IN (…))`.
 * The second arm rides `idx_execution_runs_repo` (migration 001); migration 112 left the first
 * unindexed. A planner cannot index half a disjunction, so `dashboard.registrations.list` fell
 * to a sequential scan of a table that grows with every run; with both arms indexed it can
 * BitmapOr them.
 *
 * Partial, which keeps it small: the column is non-null only for cross-repository
 * organization-wide runs, and the first arm never matches NULL (`NULL IN (…)` is never true).
 *
 * Idempotent: `IF NOT EXISTS`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_execution_runs_workflow_repo
      ON public.execution_runs (workflow_repo_identifier)
      WHERE workflow_repo_identifier IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.idx_execution_runs_workflow_repo`.execute(db);
}
