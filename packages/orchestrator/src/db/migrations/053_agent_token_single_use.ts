import { type Kysely, sql } from 'kysely';

/**
 * Add a single-use marker to agent tokens for the bootstrap (init-runner)
 * bring-up flow:
 *
 * - `agent_tokens.consumed_at timestamptz NULL` — set the first time a
 *   single-use bootstrap token is consumed (at `agent.register`). A second
 *   register with the same token is rejected. NULL = never consumed (the
 *   default for every existing static / ephemeral token, which stay reusable
 *   until expiry).
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`); additive, so staging data is
 * preserved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.agent_tokens
    ADD COLUMN IF NOT EXISTS consumed_at timestamptz`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.agent_tokens
    DROP COLUMN IF EXISTS consumed_at`.execute(db);
}
