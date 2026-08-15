import { type Kysely, sql } from 'kysely';

/**
 * Cluster-global cache tunables for the lock-file cache and the Tier-1
 * content-requirements cache.
 *
 * Six additive, nullable columns. NULL means the orchestrator's configured
 * default applies (the `KICI_LOCKFILE_CACHE_*` / `KICI_CONTENT_CACHE_*` env
 * vars stay as the cluster-wide defaults). Sizes and TTLs are structural to the
 * underlying LRU, so a change takes effect at the next orchestrator restart.
 *
 * BIGINT rather than INTEGER: a byte ceiling defaults to 64 MiB and the TTLs are
 * in milliseconds, so both leave INTEGER range as soon as an operator raises
 * them.
 *
 * Idempotent: each column is guarded on existence, so a re-run is a no-op.
 */
async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return check.rows[0]?.exists === true;
}

const COLUMNS = [
  'lockfile_cache_max',
  'lockfile_cache_max_bytes',
  'lockfile_cache_ttl_ms',
  'content_cache_max',
  'content_cache_max_bytes',
  'content_cache_ttl_ms',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const column of COLUMNS) {
    if (!(await columnExists(db, 'cluster_settings', column))) {
      await sql`ALTER TABLE public.cluster_settings ADD COLUMN ${sql.ref(column)} BIGINT`.execute(
        db,
      );
    }
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const column of COLUMNS) {
    await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS ${sql.ref(column)}`.execute(
      db,
    );
  }
}
