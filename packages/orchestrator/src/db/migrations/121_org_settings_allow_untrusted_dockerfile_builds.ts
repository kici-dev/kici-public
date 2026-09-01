import { type Kysely, sql } from 'kysely';

/**
 * Add `org_settings.allow_untrusted_dockerfile_builds boolean NOT NULL DEFAULT false`.
 *
 * A job may build its container image from a Dockerfile in the repository. That
 * build runs arbitrary `RUN` commands on the agent host's daemon, OUTSIDE the
 * hardened posture the job's own steps get (`CapDrop: ALL`, no-new-privileges,
 * pids/memory/CPU caps) — a build cannot be capability-restricted the way a
 * container run can.
 *
 * So the default is deny for an untrusted ref (a fork PR, an unresolved
 * contributor — the same classification the cache write scope uses). An operator
 * who wants fork PRs building their own images turns it on per org, deliberately.
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
