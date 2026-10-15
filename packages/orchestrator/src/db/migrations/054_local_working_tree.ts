import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.local_working_tree boolean NOT NULL DEFAULT false`: true
 * for runs of a developer's uploaded local working tree (`kici run remote`,
 * inline lock file). The dashboard shows a "Local machine" badge and builds no
 * external repository link from the repo identifier.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`); additive with a default, so existing
 * data is preserved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_runs
    ADD COLUMN IF NOT EXISTS local_working_tree boolean NOT NULL DEFAULT false`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_runs
    DROP COLUMN IF EXISTS local_working_tree`.execute(db);
}
