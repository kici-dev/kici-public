import { type Kysely, sql } from 'kysely';

/**
 * Test-run skipped environments on `execution_jobs`:
 *
 * - `skipped_environments` — JSON `string[]` of bound environments a test/local run dropped
 *   (`allowLocalExecution=false` or unconfigured). NULL = nothing skipped.
 * - `env_warning` — the user-visible warning naming them, on the dashboard run view. NULL = no
 *   warning.
 *
 * Idempotent and additive.
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
