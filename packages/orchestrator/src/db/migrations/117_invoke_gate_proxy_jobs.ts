import { type Kysely, sql } from 'kysely';

/**
 * An invoke gate summons the source repo's opt-in workflows and tracks each spawned run as a
 * **proxy job** in the gate's own run:
 *
 * - `execution_jobs.job_kind`: `standard` (runs steps on an agent), `gate` (the invoke gate
 *   itself) or `proxy` (mirrors one summoned run). The `standard` default makes pre-existing
 *   rows read correctly.
 * - `execution_jobs.summoned_run_id` — for a proxy, the spawned run it mirrors.
 * - `execution_runs.summoned_by_run_id` — for a spawned run, the summoning run.
 * - `execution_runs.summoned_by_proxy_job` — the proxy job to update on completion, even when
 *   the run finalizes on another HA instance.
 *
 * Additive; the `execution_runs` columns are nullable and unbackfilled (NULL = not summoned).
 * Idempotent per column.
 */
async function colExists(db: Kysely<unknown>, table: string, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${name}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await colExists(db, 'execution_jobs', 'job_kind'))) {
    await sql`
      ALTER TABLE public.execution_jobs
        ADD COLUMN job_kind text NOT NULL DEFAULT 'standard'
    `.execute(db);
  }
  if (!(await colExists(db, 'execution_jobs', 'summoned_run_id'))) {
    await sql`
      ALTER TABLE public.execution_jobs
        ADD COLUMN summoned_run_id text
    `.execute(db);
  }
  if (!(await colExists(db, 'execution_runs', 'summoned_by_run_id'))) {
    await sql`
      ALTER TABLE public.execution_runs
        ADD COLUMN summoned_by_run_id text
    `.execute(db);
  }
  if (!(await colExists(db, 'execution_runs', 'summoned_by_proxy_job'))) {
    await sql`
      ALTER TABLE public.execution_runs
        ADD COLUMN summoned_by_proxy_job text
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS job_kind`.execute(db);
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS summoned_run_id`.execute(db);
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS summoned_by_run_id`.execute(db);
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS summoned_by_proxy_job`.execute(
    db,
  );
}
