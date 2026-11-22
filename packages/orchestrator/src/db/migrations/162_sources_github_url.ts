import { type Kysely, sql } from 'kysely';

/**
 * `sources.github_url`: the web URL of the GitHub Enterprise Server a GitHub
 * App source talks to, where the App's JWT goes. NULL is github.com.
 *
 * A column, not a `config` key: an earlier release's generic config update
 * merges any key a token scoped to the source sends, so during a rolling
 * upgrade such a peer could still store a server in `config`. Only the
 * unscoped admin paths write this column, and `config.githubUrl` is ignored.
 *
 * Nullable, with no backfill: nothing is copied from `config.githubUrl`, so
 * every existing source reads as github.com until an operator sets its server.
 *
 * Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.sources ADD COLUMN IF NOT EXISTS github_url text`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.sources DROP COLUMN IF EXISTS github_url`.execute(db);
}
