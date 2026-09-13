import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.dashboard_write_policy jsonb NOT NULL DEFAULT '{}'`.
 *
 * Stores the per-customer policy that decides which Platform-routed
 * dashboard.* write operations the orchestrator accepts. An empty
 * JSONB object means everything is enabled (permissive default). To
 * disable an operation, set its key to `false`, e.g.
 * `{"secrets.set": false, "variables.set": false}`. Unknown / missing
 * keys are treated as `true` by the resolver in
 * `@kici-dev/engine/protocol/dashboard-write-operations`.
 *
 * Idempotent: a re-run on a DB that already has the column is a no-op.
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
