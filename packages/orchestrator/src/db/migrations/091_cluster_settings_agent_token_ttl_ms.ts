import { type Kysely, sql } from 'kysely';

/**
 * Add `cluster_settings.agent_token_ttl_ms` (nullable BIGINT).
 *
 * Fleet-wide ephemeral agent-token TTL (ms), resolved by the leader at spawn. NULL → cluster default (`config.agentTokenTtlMs`, `KICI_AGENT_TOKEN_TTL_MS`).
 *
 * Idempotent: guarded on column existence; a re-run on a DB that already has
 * the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = 'agent_token_ttl_ms'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN agent_token_ttl_ms BIGINT`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS agent_token_ttl_ms`.execute(
    db,
  );
}
