import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_jobs.environments`: a JSON-encoded `string[]` of the environment names a job
 * binds, in merge order. Written at dispatch with the static names (impure dynamic elements as a
 * `(dynamic)` placeholder), then overwritten with the full list when a deferred-init agent eval
 * resolves them. NULL = no environment. Idempotent and additive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_jobs
    ADD COLUMN IF NOT EXISTS environments text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_jobs
    DROP COLUMN IF EXISTS environments`.execute(db);
}
