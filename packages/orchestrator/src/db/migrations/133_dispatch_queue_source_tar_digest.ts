import { type Kysely, sql } from 'kysely';

/**
 * Add `dispatch_queue.source_tar_digest TEXT NULL` — the SHA-256 of the source
 * tarball's own bytes, so the agent can verify what it downloaded before
 * extracting it.
 *
 * Despite its name, `source_tar_hash` carries the workflow `contentHash`, so the
 * agent had no digest to check the bytes against. This is the source-side
 * sibling of `deps_hash`, which holds its tarball's real digest.
 *
 * Nullable, no default: NULL means no digest is known (every older row, and any
 * source not from the content-addressed cache). The agent then restores
 * unverified, so an in-flight queue survives the upgrade.
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
