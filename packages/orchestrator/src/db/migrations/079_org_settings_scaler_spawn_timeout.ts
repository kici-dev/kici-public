import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.scaler_spawn_timeout_ms BIGINT` (nullable).
 *
 * Per-org deadline for a single scaler `backend.spawn` (image pull + container
 * create + start). NULL falls back to the cluster-wide default
 * (`KICI_SCALER_SPAWN_TIMEOUT_MS`, default 300s). Operators tune it per tenant
 * via `kici-admin org-settings scaler-spawn-timeout`.
 *
 * Idempotent: a re-run on a DB that already has the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = 'scaler_spawn_timeout_ms'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.org_settings
      ADD COLUMN scaler_spawn_timeout_ms BIGINT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS scaler_spawn_timeout_ms
  `.execute(db);
}
