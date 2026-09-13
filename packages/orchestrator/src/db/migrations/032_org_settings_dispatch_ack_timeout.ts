import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.dispatch_ack_timeout_ms BIGINT` (nullable).
 *
 * Per-org override of the dispatch-acknowledgment deadline. NULL falls
 * back to the cluster-wide default (`KICI_DISPATCH_ACK_TIMEOUT_MS`,
 * default 10s). Operators raise it on high-latency networks via
 * `kici-admin org-settings`.
 *
 * Idempotent: a re-run on a DB that already has the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = 'dispatch_ack_timeout_ms'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.org_settings
      ADD COLUMN dispatch_ack_timeout_ms BIGINT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS dispatch_ack_timeout_ms
  `.execute(db);
}
