import { type Kysely, sql } from 'kysely';

/**
 * Add `cluster_settings.sealed_secrets_retry_backoff_ms` (nullable bigint).
 *
 * How long a coordinator leaves a queued job alone after it claimed the job and
 * could not open its sealed secrets: the job was sealed with a master key this
 * coordinator does not hold. During a rolling key rotation a coordinator that
 * holds the key can take the job in that window; after it, this coordinator can
 * claim the job again, and each claim spends another dispatch attempt, so a job
 * no coordinator can open still fails.
 *
 * Cluster-global (every coordinator drains the same queue), so it lives on
 * `cluster_settings` rather than `org_settings`. NULL ⇒ the orchestrator's own
 * configured default applies.
 *
 * Idempotent: guarded on column existence; a re-run on a DB that already has the
 * column is a no-op.
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
