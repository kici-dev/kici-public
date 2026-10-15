import { type Kysely, sql } from 'kysely';

/**
 * `join_tokens.consumed_by_instance`: the joining peer's `instanceId` at first consumption
 * (distinct from `consumed_by`, the coordinator that processed the claim).
 *
 * The same peer instance may reuse the token until `expires_at`, so a peer that lost its
 * credential self-heals by re-presenting the join token in its env, with no operator action.
 * Idempotent and additive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.join_tokens
    ADD COLUMN IF NOT EXISTS consumed_by_instance text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.join_tokens DROP COLUMN IF EXISTS consumed_by_instance`.execute(db);
}
