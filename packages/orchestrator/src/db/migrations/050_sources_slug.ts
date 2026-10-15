import { type Kysely, sql } from 'kysely';

/**
 * Add `sources.slug TEXT NULL` — the GitHub App slug (the URL-safe identifier
 * GitHub assigns, e.g. `my-kici-app`).
 *
 * GitHub owns both the display `name` and the `slug`: captured at creation,
 * kept fresh by the daily refresher and `kici-admin source refresh`. NULL until
 * an identity fetch populates it (a failed manual `--app-id` fetch, or a row
 * older than this column).
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`); additive, so existing data is
 * preserved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.sources
    ADD COLUMN IF NOT EXISTS slug text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.sources DROP COLUMN IF EXISTS slug`.execute(db);
}
