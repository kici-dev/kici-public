import { type Kysely, sql } from 'kysely';

/**
 * `dep_cache_key_sha`: the `commit_sha` stored with `lockfile_hash` and `siblings_digest`. A run
 * dispatched from the registration uses the key only while it equals the row's `commit_sha`. A
 * writer unaware of the key columns (an older orchestrator or `kici-admin` mid-upgrade or after
 * a downgrade) moves `commit_sha` and `lock_entry` but leaves a stale key; the commits then
 * differ, and the run installs on the agent instead of restoring the wrong dependencies.
 *
 * Nullable and unbackfilled: an older row uses no key until its repository's next
 * default-branch push writes both again.
 *
 * Idempotent.
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
