import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.allow_http_npm_registries boolean NOT NULL DEFAULT false`.
 *
 * Operators flip this on a per-org basis to permit `http://` (non-HTTPS)
 * registry URLs in workflow `registries:` declarations. By default only
 * `https://` registries are accepted, with an automatic exemption for
 * loopback / `*.local` / private link-local hosts so dev fixtures
 * (Verdaccio at `http://verdaccio.local:4873`) keep working.
 *
 * Idempotent: a re-run on a DB that already has the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = 'allow_http_npm_registries'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.org_settings
      ADD COLUMN allow_http_npm_registries boolean NOT NULL DEFAULT false
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS allow_http_npm_registries
  `.execute(db);
}
