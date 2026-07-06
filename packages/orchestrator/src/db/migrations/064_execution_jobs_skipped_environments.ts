import { type Kysely, sql } from 'kysely';

/**
 * Add the test-run skipped-environment columns to `execution_jobs`:
 *
 * - `execution_jobs.skipped_environments text NULL` — a JSON-encoded `string[]`
 *   of the bound environment names dropped on a test/local run because they
 *   disallow local execution (`allowLocalExecution=false`) or are unconfigured.
 *   NULL = nothing skipped.
 * - `execution_jobs.env_warning text NULL` — the user-visible warning naming the
 *   skipped environments, surfaced on the dashboard run view. NULL = no warning.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`); additive, so staging data is
 * preserved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_jobs
    ADD COLUMN IF NOT EXISTS skipped_environments text`.execute(db);
  await sql`ALTER TABLE public.execution_jobs
    ADD COLUMN IF NOT EXISTS env_warning text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_jobs
    DROP COLUMN IF EXISTS skipped_environments`.execute(db);
  await sql`ALTER TABLE public.execution_jobs
    DROP COLUMN IF EXISTS env_warning`.execute(db);
}
