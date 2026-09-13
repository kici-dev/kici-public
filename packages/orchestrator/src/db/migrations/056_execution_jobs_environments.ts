import { type Kysely, sql } from 'kysely';

/**
 * Add a per-job bound deployment-environment list to `execution_jobs`:
 *
 * - `execution_jobs.environments text NULL` — a JSON-encoded `string[]` of the
 *   ordered environment names a job binds (`environments: [...]`), in merge
 *   order. Written at dispatch with the statically-resolved names (impure
 *   dynamic elements as a `(dynamic)` placeholder), then overwritten with the
 *   fully-resolved list when a deferred-init agent eval resolves dynamic
 *   elements. NULL = the job binds no environment.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`); additive, so staging data is
 * preserved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_jobs
    ADD COLUMN IF NOT EXISTS environments text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_jobs
    DROP COLUMN IF EXISTS environments`.execute(db);
}
