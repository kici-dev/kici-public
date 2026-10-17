import { type Kysely, sql } from 'kysely';

/**
 * `execution_jobs.workflow_name`: the workflow that defines the job. A fixture
 * run with no `--workflow` runs every matched workflow under one run id, so
 * `execution_runs.workflow_name` (the first matched workflow) does not say
 * which workflow a job belongs to.
 *
 * Nullable, with no backfill: a row written before this column reads as
 * unknown, and the readers fall back to the run's workflow for a run that can
 * span only one.
 *
 * Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_jobs ADD COLUMN IF NOT EXISTS workflow_name text
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS workflow_name`.execute(db);
}
