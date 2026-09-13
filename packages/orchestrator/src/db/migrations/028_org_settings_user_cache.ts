import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.user_cache_quota_bytes bigint` and
 * `org_settings.user_cache_ttl_ms bigint`, both NULLABLE.
 *
 * These make the user-facing cache per-org byte quota and per-entry TTL
 * cluster-configurable (runtime-editable per `customer_id` via the admin
 * route + `kici-admin org-settings user-cache` CLI). A NULL value means
 * "use the cluster-wide default" — the `KICI_USER_CACHE_QUOTA_BYTES` /
 * `KICI_USER_CACHE_TTL_MS` env vars (5 GiB / 7 days) resolved in config.ts.
 *
 * BIGINT because a quota in bytes (5 GiB = 5_368_709_120) and a TTL in ms
 * (7 days = 604_800_000) both exceed the safe range only at extreme values,
 * but a quota can legitimately reach tens of GiB; BIGINT keeps headroom and
 * matches the sibling `log_bytes` bigint columns.
 *
 * Idempotent: a re-run on a DB that already has either column skips it.
 */
async function columnExists(db: Kysely<unknown>, column: string): Promise<boolean> {
  const res = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return res.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await columnExists(db, 'user_cache_quota_bytes'))) {
    await sql`
      ALTER TABLE public.org_settings
        ADD COLUMN user_cache_quota_bytes bigint
    `.execute(db);
  }
  if (!(await columnExists(db, 'user_cache_ttl_ms'))) {
    await sql`
      ALTER TABLE public.org_settings
        ADD COLUMN user_cache_ttl_ms bigint
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS user_cache_quota_bytes
  `.execute(db);
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS user_cache_ttl_ms
  `.execute(db);
}
