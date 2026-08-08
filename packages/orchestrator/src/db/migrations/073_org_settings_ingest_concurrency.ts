import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.ingest_max_concurrency BIGINT` (nullable).
 *
 * Per-org fairness cap for the webhook-ingest admission controller. NULL falls
 * back to the cluster-wide default (`KICI_INGEST_ORG_MAX_CONCURRENCY`, default
 * 32). Operators tune it per tenant via `kici-admin org-settings`.
 *
 * Idempotent: a re-run on a DB that already has the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = 'ingest_max_concurrency'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.org_settings
      ADD COLUMN ingest_max_concurrency BIGINT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS ingest_max_concurrency
  `.execute(db);
}
