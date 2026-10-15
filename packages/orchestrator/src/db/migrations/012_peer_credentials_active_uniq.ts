import { type Kysely, sql } from 'kysely';

/**
 * Add a partial unique index on `peer_credentials (instance_id) WHERE
 * revoked_at IS NULL` so two ACTIVE rows for the same `instance_id` become a
 * database-level impossibility.
 *
 * Why: `PeerCredentialStore.save()` ran an unguarded `UPDATE … SET revoked_at
 * = NOW()` then `INSERT` (no transaction, no constraint), which races when a
 * joining peer fans out one peer-client per coordinator: both `UPDATE`s revoke
 * nothing, both `INSERT`s land, and the peer's credential file can hold a hash
 * a concurrent `save()` revoked — an endless "Peer HMAC proof invalid" loop.
 *
 * `up()` first dedupes existing duplicates (revokes all but the newest active
 * row per `instance_id`), which databases from before the constraint may hold.
 *
 * `down()` only drops the index; it does NOT undo the dedupe (revoked rows
 * cannot be safely recreated, and the dedupe is monotonic).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE public.peer_credentials
    SET revoked_at = NOW()
    WHERE revoked_at IS NULL
      AND id NOT IN (
        SELECT DISTINCT ON (instance_id) id
        FROM public.peer_credentials
        WHERE revoked_at IS NULL
        ORDER BY instance_id, created_at DESC
      )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX peer_credentials_active_uniq
      ON public.peer_credentials (instance_id)
      WHERE revoked_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.peer_credentials_active_uniq`.execute(db);
}
