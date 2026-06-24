import { type Kysely, sql } from 'kysely';

/**
 * Add `sources.slug TEXT NULL` — the GitHub App slug (the URL-safe identifier
 * GitHub assigns, e.g. `my-kici-app`).
 *
 * For GitHub-App sources GitHub is the source of truth for both the display
 * `name` and the `slug`: both are captured at creation and kept fresh by the
 * daily refresher + `kici-admin source refresh`. NULL when the identity fetch
 * hasn't populated it yet (manual `--app-id` flow whose initial fetch failed,
 * or a row created before the rollout).
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`); additive, so staging data is
 * preserved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.sources
    ADD COLUMN IF NOT EXISTS slug text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.sources DROP COLUMN IF EXISTS slug`.execute(db);
}
