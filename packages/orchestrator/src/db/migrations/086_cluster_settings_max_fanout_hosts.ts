import { type Kysely, sql } from 'kysely';

/**
 * Add `cluster_settings.max_fanout_hosts` (nullable INTEGER).
 *
 * Fleet-wide cap on `runsOnAll` per-host fan-out children. NULL → cluster default (`config.maxFanoutHosts`, `KICI_MAX_FANOUT_HOSTS`).
 *
 * Idempotent: guarded on column existence; a re-run on a DB that already has
 * the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = 'max_fanout_hosts'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN max_fanout_hosts INTEGER`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS max_fanout_hosts`.execute(db);
}
