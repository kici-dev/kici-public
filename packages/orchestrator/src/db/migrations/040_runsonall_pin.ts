import { type Kysely, sql } from 'kysely';

/**
 * Add the `runsOnAll` host fan-out columns:
 *
 * - `dispatch_queue.pinned_agent_id TEXT` — when set, the queued/dispatched job
 *   targets exactly that agent (a host-fanout child). The dispatcher routes it
 *   only to that agent; the queue drain never hands it to a different one.
 * - `execution_jobs.base_job_name` / `variant_kind` / `variant_label` — generic
 *   fan-out columns (matrix + host uniform). `variant_kind` is `'matrix'` or
 *   `'host'`; `variant_label` is the matrix suffix or the hostname. They make the
 *   logical fan-out job first-class server-side so the dashboard groups on real
 *   fields instead of string-parsing the job name. (`matrix_values` / `group_name`
 *   already exist; the matrix path now also backfills `variant_kind='matrix'`.)
 *
 * Idempotent: re-running on a DB that already has any column is a no-op.
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
  if (!(await colExists(db, 'dispatch_queue', 'pinned_agent_id'))) {
    await sql`ALTER TABLE public.dispatch_queue ADD COLUMN pinned_agent_id TEXT`.execute(db);
  }
  if (!(await colExists(db, 'execution_jobs', 'base_job_name'))) {
    await sql`ALTER TABLE public.execution_jobs ADD COLUMN base_job_name TEXT`.execute(db);
  }
  if (!(await colExists(db, 'execution_jobs', 'variant_kind'))) {
    await sql`ALTER TABLE public.execution_jobs ADD COLUMN variant_kind TEXT`.execute(db);
  }
  if (!(await colExists(db, 'execution_jobs', 'variant_label'))) {
    await sql`ALTER TABLE public.execution_jobs ADD COLUMN variant_label TEXT`.execute(db);
  }

  // Partial index supports the pin-aware drain's
  // `WHERE status='queued' AND pinned_agent_id = $agent`.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_pinned_agent
      ON public.dispatch_queue (pinned_agent_id)
      WHERE pinned_agent_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.idx_dispatch_queue_pinned_agent`.execute(db);
  await sql`ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS pinned_agent_id`.execute(db);
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS variant_label`.execute(db);
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS variant_kind`.execute(db);
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS base_job_name`.execute(db);
}
