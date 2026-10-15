import { type Kysely, sql } from 'kysely';

/**
 * `cluster_settings.version`, monotonic and bumped on each settings change. The leader
 * advertises it on `peer.heartbeat`, so DB-less workers detect a change and pull the
 * worker-relevant settings snapshot. DB-backed, so a newly elected leader continues
 * monotonically after failover.
 *
 * Idempotent: guarded on column existence.
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
