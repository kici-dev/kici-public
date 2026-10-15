import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.allow_http_npm_registries boolean NOT NULL DEFAULT false`.
 *
 * Per-org opt-in for `http://` registry URLs in workflow `registries:`. Otherwise only
 * `https://` is accepted, except loopback / `*.local` / private link-local hosts, so a local
 * registry (for example `http://registry.local:4873`) keeps working.
 *
 * Idempotent.
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
