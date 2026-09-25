import { type Kysely, sql } from 'kysely';

/**
 * Record the workflow repository's commit and registered branch for a run whose
 * workflow is defined in another repository.
 *
 * `execution_runs.workflow_repo_identifier` names the repository that defines
 * the workflow. `workflow_sha` is the commit of that repository the run
 * dispatched, so a re-run dispatches that exact commit. `workflow_branch` is the
 * workflow repository's registered branch, which the git-credential relay
 * checks context branch rules against.
 *
 * Nullable and unbackfilled: null on every per-repository run, and on every row
 * written before these columns existed.
 *
 * Idempotent: guarded on each column's existence, so re-running is a no-op.
 */
async function colExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = ${name}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await colExists(db, 'workflow_sha'))) {
    await sql`ALTER TABLE public.execution_runs ADD COLUMN workflow_sha text`.execute(db);
  }
  if (!(await colExists(db, 'workflow_branch'))) {
    await sql`ALTER TABLE public.execution_runs ADD COLUMN workflow_branch text`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS workflow_branch`.execute(db);
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS workflow_sha`.execute(db);
}
