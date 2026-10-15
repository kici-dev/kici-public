import { type Kysely, sql } from 'kysely';

/**
 * `org_settings.queue_timeout_ms BIGINT` (nullable): per-org dispatch-queue job
 * timeout. A queued job's deadline is
 * `job.timeoutMs ?? <per-org queue_timeout_ms> ?? config.queueTimeoutMs`; NULL
 * falls back to `KICI_QUEUE_TIMEOUT_MS` (default 1h). Tuned per tenant via
 * `kici-admin org-settings queue-timeout`.
 *
 * Per-org because the read site (`JobQueue.enqueue`) has the job's
 * `cacheOrgId` in scope; fleet-wide tunables live on `cluster_settings`
 * (migration 080). Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = 'queue_timeout_ms'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.org_settings
      ADD COLUMN queue_timeout_ms BIGINT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS queue_timeout_ms
  `.execute(db);
}
