import { type Kysely, sql } from 'kysely';

/**
 * Mark runs that executed an uploaded local working tree (`kici run remote`):
 *
 * - `execution_runs.local_working_tree boolean NOT NULL DEFAULT false` — true
 *   for runs that ran a developer's local working tree from the CLI (inline
 *   lock file). The dashboard renders a "Local machine" badge for these runs
 *   and avoids building an external repository link from the repo identifier.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`); additive with a default, so staging
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
