import { type Kysely, sql } from 'kysely';

/**
 * Record which repository DEFINED the workflow a run executed.
 *
 * `execution_runs.repo_identifier` is the repository the run acted on. For an
 * organization-wide workflow it is the event's source repository; the defining
 * one travels only per job in `jobConfig.workflowRepoIdentifier`
 * (`dispatch_queue.job_config`, pruned once the queue rows age out).
 *
 * Without this column the rerun path read `repo_identifier` as the defining
 * repository: it re-fetched the source repository's lock file and either failed
 * with a misleading force-push message or silently ran a same-named workflow.
 *
 * Nullable and unbackfilled by design: null means the run acted on the
 * repository that defines its workflow, true of every per-repository run and
 * every row older than this column.
 *
 * Idempotent: guarded on the column's existence, so re-running is a no-op.
 */
async function colExists(db: Kysely<unknown>, table: string, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${name}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await colExists(db, 'execution_runs', 'workflow_repo_identifier'))) {
    await sql`
      ALTER TABLE public.execution_runs
        ADD COLUMN workflow_repo_identifier text
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS workflow_repo_identifier
  `.execute(db);
}
