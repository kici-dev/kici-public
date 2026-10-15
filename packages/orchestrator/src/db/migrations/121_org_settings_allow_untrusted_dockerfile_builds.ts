import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.allow_untrusted_dockerfile_builds boolean NOT NULL DEFAULT false`.
 *
 * A job may build its image from a repository Dockerfile, whose `RUN` commands
 * execute on the agent host's daemon OUTSIDE the hardened step posture
 * (`CapDrop: ALL`, no-new-privileges, pids/memory/CPU caps): a build cannot be
 * capability-restricted like a container run.
 *
 * So it is denied by default for an untrusted ref (a fork PR, an unresolved
 * contributor — the cache write scope's classification); an operator opts in
 * per org.
 *
 * Idempotent: a re-run on a DB that already has the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = 'allow_untrusted_dockerfile_builds'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.org_settings
      ADD COLUMN allow_untrusted_dockerfile_builds boolean NOT NULL DEFAULT false
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.org_settings DROP COLUMN IF EXISTS allow_untrusted_dockerfile_builds
  `.execute(db);
}
