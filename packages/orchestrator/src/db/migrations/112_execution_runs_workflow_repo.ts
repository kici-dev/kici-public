import { type Kysely, sql } from 'kysely';

/**
 * Record which repository DEFINED the workflow a run executed.
 *
 * `execution_runs.repo_identifier` is the repository the run acted on. For an
 * organization-wide workflow dispatched against another repository those are
 * two different repositories: `repo_identifier` holds the source repository
 * that emitted the event, while the workflow itself was authored elsewhere and
 * travels only per job in `jobConfig.workflowRepoIdentifier` — which lives in
 * `dispatch_queue.job_config` and is pruned once the run's queue rows age out.
 *
 * So the run row alone could not answer "which repository defines this
 * workflow", and the rerun path read `repo_identifier` as the answer: it
 * re-fetched the source repository's lock file and either failed with a
 * misleading force-push message or, on a same-named workflow, silently ran the
 * source repository's workflow instead.
 *
 * Nullable and unbackfilled by design: a null means "the run acted on the
 * repository that defines its workflow", which is true of every per-repository
 * run and of every row written before this column existed.
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
