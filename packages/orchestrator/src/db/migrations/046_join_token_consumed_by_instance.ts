import { type Kysely, sql } from 'kysely';

/**
 * Record the joining peer's instanceId at first consumption of a join token:
 *
 * - `join_tokens.consumed_by_instance text` — the `instanceId` of the peer that
 *   consumed the token. This is the *joining peer*, distinct from `consumed_by`
 *   (the coordinator that processed the claim). It lets a token be reused by the
 *   same peer instance until `expires_at`, so a peer that lost its credential
 *   (transient outage / deleted credential file) self-heals by re-presenting the
 *   join token already in its env — no operator action, no cluster redeploy.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`): re-running on a DB that already has
 * the column is a no-op. Staging data is preserved (additive nullable column).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.join_tokens
    ADD COLUMN IF NOT EXISTS consumed_by_instance text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.join_tokens DROP COLUMN IF EXISTS consumed_by_instance`.execute(db);
}
