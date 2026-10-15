import { type Kysely, sql } from 'kysely';

/**
 * `agent_tokens.consumed_at timestamptz NULL`: the single-use marker for the
 * bootstrap (init-runner) flow, set when a single-use token is consumed at
 * `agent.register`; a second register with it is rejected. NULL = never
 * consumed, the default for existing static / ephemeral tokens, which stay
 * reusable until expiry.
 *
 * Idempotent and additive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.agent_tokens
    ADD COLUMN IF NOT EXISTS consumed_at timestamptz`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.agent_tokens
    DROP COLUMN IF EXISTS consumed_at`.execute(db);
}
