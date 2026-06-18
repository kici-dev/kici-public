import { type Kysely, sql } from 'kysely';

/**
 * Add a partial unique index on `peer_credentials (instance_id) WHERE
 * revoked_at IS NULL` so two ACTIVE rows for the same `instance_id` become a
 * database-level impossibility.
 *
 * Background: `PeerCredentialStore.save()` historically ran an `UPDATE …
 * SET revoked_at = NOW()` followed by an `INSERT` without a transaction or
 * unique constraint. When a joining peer fanned out N peer-clients in
 * parallel (one per coordinator), each coordinator's `save()` could run its
 * `UPDATE` before the others' `INSERT`s committed — both `UPDATE`s revoked
 * nothing and both `INSERT`s succeeded, leaving 2+ ACTIVE rows for the same
 * `instance_id`. The peer's local credential file then ended up holding a
 * hash that a later concurrent `save()` had revoked, causing an endless
 * "Peer HMAC proof invalid" loop. See
 *  for the
 * full incident write-up (DB rows + log evidence from real staging deploys).
 *
 * The `up()` first dedupes any pre-existing duplicates (revoke all but the
 * newest active row per `instance_id`) — required because earlier migrations
 * predate the constraint and existing staging DBs already have the dupes.
 *
 * `down()` only drops the index; it does NOT undo the dedupe (there's no
 * safe way to recreate revoked rows, and the dedupe is monotonic).
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
