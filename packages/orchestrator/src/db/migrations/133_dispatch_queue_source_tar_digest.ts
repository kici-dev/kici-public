import { type Kysely, sql } from 'kysely';

/**
 * Add `dispatch_queue.source_tar_digest TEXT NULL` — the SHA-256 of the source
 * tarball's own bytes, so the agent can verify what it downloaded before
 * extracting it.
 *
 * The neighbouring `source_tar_hash` column carries the workflow `contentHash`
 * despite its name, which is why the agent's restore path verified nothing: it
 * had no value to compare the bytes against. `deps_hash` next door has always
 * held its tarball's real digest, and this column is its source-side sibling.
 *
 * Nullable, with no default: NULL means "no digest known for this row", which
 * is true of every row written before the column existed and of any dispatch
 * whose source came from somewhere other than the content-addressed cache. The
 * agent treats NULL as "nothing to verify against" and restores unverified,
 * exactly as it did before — so an in-flight queue survives the upgrade.
 *
 * Idempotent: the add is guarded on existence and the drop uses IF EXISTS, so a
 * re-run is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'dispatch_queue'
         AND column_name = 'source_tar_digest'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists === true) return;

  await sql`
    ALTER TABLE public.dispatch_queue
      ADD COLUMN source_tar_digest TEXT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS source_tar_digest
  `.execute(db);
}
