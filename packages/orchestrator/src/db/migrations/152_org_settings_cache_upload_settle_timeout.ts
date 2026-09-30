import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.cache_upload_settle_timeout_ms BIGINT` (nullable).
 *
 * Per-org bound on how long a build job's `job.status success` waits for the
 * cache publish (object metadata plus pointer) its agent reported just before
 * it. NULL falls back to the cluster default
 * (`KICI_CACHE_UPLOAD_SETTLE_TIMEOUT_MS`, 10s); 0 turns the wait off. Operators
 * tune it via `kici-admin org-settings cache-upload-settle`.
 *
 * Idempotent: a re-run on a DB that already has the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = 'cache_upload_settle_timeout_ms'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.org_settings
      ADD COLUMN cache_upload_settle_timeout_ms BIGINT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS cache_upload_settle_timeout_ms
  `.execute(db);
}
