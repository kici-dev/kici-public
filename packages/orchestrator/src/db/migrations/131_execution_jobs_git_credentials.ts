import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_jobs.git_credentials`: the job lock entry's `gitCredentials` map, as server
 * truth the credential relay reads on the hot path. The relay runs on every git network
 * operation, so it must not re-parse a lock file, and `execution_jobs` has no config column, so
 * the declaration is written at dispatch.
 *
 * Values follow `LockJob.gitCredentials`: a `<name>Secret` field is a qualified
 * `<context>:<key>` secret NAME; a `<name>Value` sibling carries material for a credential with
 * no store entry. Stored verbatim as the declaration the relay compares requests against, not a
 * secret store.
 *
 * Nullable, no default: NULL means "declared no git credentials" (nearly every job, and every
 * older row); a default would name a declaration nobody made. The row is written after the
 * dispatch loop, so NULL also covers "not written yet", which the relay resolves against the
 * job's dispatch record (`git/job-context.ts`). Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_jobs'
         AND column_name = 'git_credentials'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists === true) return;

  await sql`
    ALTER TABLE public.execution_jobs
      ADD COLUMN git_credentials JSONB
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS git_credentials
  `.execute(db);
}
