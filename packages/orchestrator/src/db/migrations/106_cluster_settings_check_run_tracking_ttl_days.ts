import { type Kysely, sql } from 'kysely';

/**
 * Add `cluster_settings.check_run_tracking_ttl_days` (nullable integer).
 *
 * Retention window for `check_run_tracking` rows. The hourly cleanup sweep
 * deletes rows untouched for longer than this; 0 disables the sweep.
 *
 * Cluster-global (the sweep runs once per fleet on the cleanup tick, with no
 * tenant in scope at the read site), so it lives on `cluster_settings` rather
 * than `org_settings`. NULL means the orchestrator's own configured default
 * applies.
 *
 * Idempotent: guarded on column existence; a re-run on a database that already
 * has the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = 'check_run_tracking_ttl_days'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN check_run_tracking_ttl_days INTEGER`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS check_run_tracking_ttl_days`.execute(
    db,
  );
}
