import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.dashboard_write_policy jsonb NOT NULL DEFAULT '{}'`.
 *
 * Per-customer policy for which Platform-routed dashboard.* write operations the orchestrator
 * accepts. A key set to `false` disables that operation (e.g. `{"secrets.set": false}`);
 * missing keys resolve to `true` in `@kici-dev/engine/protocol/dashboard-write-operations`, so
 * `{}` enables everything.
 *
 * Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = 'dashboard_write_policy'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.org_settings
      ADD COLUMN dashboard_write_policy jsonb NOT NULL DEFAULT '{}'::jsonb
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS dashboard_write_policy
  `.execute(db);
}
