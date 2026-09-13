import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_jobs.git_credentials JSONB NULL` — the `gitCredentials` map the
 * job's lock entry declared, as server truth the credential relay can read on
 * the hot path.
 *
 * The relay is called on every git network operation, so it must not re-fetch
 * or re-parse a lock file to learn what a job is allowed to ask for. The
 * orchestrator persists no per-job lock entry (`execution_jobs` carries no
 * config column), so the declaration is written at dispatch and read back here.
 *
 * Values follow `LockJob.gitCredentials`: a `<name>Secret` field is a secret
 * NAME in qualified `<context>:<key>` form, while its `<name>Value` sibling
 * carries material for a credential with no store entry to name. The column
 * stores whichever the lock declared, verbatim — it is the declaration the
 * relay compares a request against, not a secret store of its own.
 *
 * Nullable, with no default: NULL means "this job declared no git credentials",
 * which is true of nearly every job and of every row written before this column
 * existed. A default would have to name a declaration nobody made. The row is
 * written after the dispatch loop, so NULL also covers "not written yet" — the
 * relay resolves that ambiguity against the job's dispatch record rather than
 * reading it as a declaration (`git/job-context.ts`).
 *
 * Idempotent: the add is guarded on existence and the drop uses IF EXISTS, so a
 * re-run is a no-op.
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
