import { type Kysely, sql } from 'kysely';

/**
 * Add `cluster_settings.version` (monotonic BIGINT, bumped on each settings
 * change).
 *
 * The leader advertises this version on `peer.heartbeat` so DB-less workers can
 * detect a change and pull the worker-relevant settings snapshot. DB-backed
 * (not an in-memory counter) so it survives leader failover: a newly-elected
 * leader continues monotonically from the row's current value.
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
         AND column_name = 'version'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN version BIGINT NOT NULL DEFAULT 0`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS version`.execute(db);
}
