import { type Kysely, sql } from 'kysely';

/**
 * Fleet-wide dependency-cache entry TTL (days): an entry unread for longer expires on the next
 * lookup. NULL → cluster default (`config.cacheTtlDays`, `KICI_CACHE_TTL_DAYS`).
 *
 * Idempotent: guarded on column existence.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = 'cache_ttl_days'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.cluster_settings ADD COLUMN cache_ttl_days INTEGER`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS cache_ttl_days`.execute(db);
}
