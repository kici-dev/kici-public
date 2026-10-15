import { type Kysely, sql } from 'kysely';

/**
 * Add the `runsOnAll` host fan-out columns:
 *
 * - `dispatch_queue.pinned_agent_id TEXT` — when set, the job (a host-fanout
 *   child) is dispatched and drained only to exactly that agent.
 * - `execution_jobs.base_job_name` / `variant_kind` (`'matrix'` | `'host'`) /
 *   `variant_label` (matrix suffix or hostname) — uniform fan-out columns, so
 *   the dashboard groups on real fields instead of parsing the job name. The
 *   matrix path also sets `variant_kind='matrix'`.
 *
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
