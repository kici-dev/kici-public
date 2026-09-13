import { type Kysely, sql } from 'kysely';

/**
 * Add the partial index `idx_execution_runs_workflow_repo` on
 * `execution_runs (workflow_repo_identifier) WHERE workflow_repo_identifier IS NOT NULL`.
 *
 * Matching a workflow registration to its runs keys on the repository that
 * DEFINES the workflow — `workflow_repo_identifier ?? repo_identifier` — which
 * the orchestrator expresses as
 * `workflow_repo_identifier IN (…) OR (workflow_repo_identifier IS NULL AND repo_identifier IN (…))`
 * (`registration/registration-run-match.ts`). The second arm rides
 * `idx_execution_runs_repo` from migration 001; the first arm had no index at
 * all, because migration 112 added the column without one. A planner cannot
 * use an index for only half a disjunction, so the whole predicate degraded to
 * a sequential scan over a table that grows with every run — on
 * `dashboard.registrations.list`, which runs its grouped MAX on every list
 * request.
 *
 * With both arms indexed the planner can BitmapOr them.
 *
 * Partial by design, and the partiality is what makes it cheap: the column is
 * non-null only for a cross-repository organization-wide run, a small minority
 * of rows, so the index stays a fraction of the table's size and skips every
 * per-repository run. It also matches the predicate exactly — the first arm
 * can never match a NULL row, since `NULL IN (…)` is never true.
 *
 * Idempotent: `IF NOT EXISTS` makes a re-run a no-op.
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
