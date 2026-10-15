import { type Kysely, sql } from 'kysely';

/**
 * How long a coordinator leaves a queued job alone after failing to open its sealed secrets
 * (sealed under a master key it does not hold). During a rolling key rotation a coordinator
 * holding the key can take the job in that window; each later re-claim spends a dispatch
 * attempt, so a job no coordinator can open still fails.
 *
 * On `cluster_settings` because every coordinator drains the same queue. NULL ⇒ the
 * orchestrator's configured default.
 *
 * Idempotent: guarded on column existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = 'sealed_secrets_retry_backoff_ms'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN sealed_secrets_retry_backoff_ms BIGINT`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS sealed_secrets_retry_backoff_ms`.execute(
    db,
  );
}
