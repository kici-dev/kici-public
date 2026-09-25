import { type Kysely, sql } from 'kysely';

/**
 * Record the commit a workflow registration's dependency-cache key was written for.
 *
 * `workflow_registrations.dep_cache_key_sha` is the `commit_sha` the writer stored
 * together with `lockfile_hash` and `siblings_digest`. A run dispatched from the
 * registration uses the key only while this column equals the row's `commit_sha`.
 * A writer that does not know the key columns (an orchestrator or `kici-admin`
 * from before them, during a rolling upgrade or after a downgrade) moves
 * `commit_sha` and `lock_entry` but leaves the key of an older lock file behind;
 * the two commits then differ, and the run installs its dependencies on the agent
 * instead of restoring that older lock file's dependencies.
 *
 * Nullable and unbackfilled: null on every row written before this column
 * existed, so no such row uses its key until its repository's next
 * default-branch push writes both again.
 *
 * Idempotent: guarded on the column's existence, so re-running is a no-op.
 */
async function colExists(db: Kysely<unknown>): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'workflow_registrations'
         AND column_name = 'dep_cache_key_sha'
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (await colExists(db)) return;
  await sql`ALTER TABLE public.workflow_registrations ADD COLUMN dep_cache_key_sha text`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.workflow_registrations DROP COLUMN IF EXISTS dep_cache_key_sha`.execute(
    db,
  );
}
