import { type Kysely, sql } from 'kysely';

/**
 * Remove `githubUrl` from every stored `sources.config`.
 *
 * Earlier releases' generic config update did not strip the key, so a token
 * scoped to one source could store any value there. The server of a GitHub
 * App source lives in `sources.github_url` (migration 162), and
 * `config.githubUrl` is ignored; this removes the stale values so no copy of
 * an unvalidated server stays in the table.
 *
 * Rows without the key are not touched. `down` is a no-op: the removed values
 * were never read.
 *
 * Idempotent: a second run matches no row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE public.sources SET config = config - 'githubUrl' WHERE config ? 'githubUrl'
  `.execute(db);
}

export async function down(): Promise<void> {}
