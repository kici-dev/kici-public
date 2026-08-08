import { type Kysely, sql } from 'kysely';

/**
 * Add `cluster_settings.cache_max_tarball_bytes` (nullable BIGINT).
 *
 * Fleet-wide maximum dependency-cache tarball size (bytes); a larger store is rejected. NULL → cluster default (`config.cacheMaxTarballBytes`, `KICI_CACHE_MAX_TARBALL_BYTES`).
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
         AND column_name = 'cache_max_tarball_bytes'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN cache_max_tarball_bytes BIGINT`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS cache_max_tarball_bytes`.execute(
    db,
  );
}
