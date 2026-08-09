import { type Kysely, sql } from 'kysely';

/**
 * Fast-fail support for jobs nothing in the fleet can run.
 *
 * Three additive, nullable columns:
 *
 * - `cluster_settings.unroutable_grace_ms` — how long a job may stay
 *   continuously unroutable before it is terminalized. NULL means the
 *   orchestrator's configured default applies; 0 disables fast-fail and leaves
 *   the `queue_timeout_ms` backstop as the only path.
 * - `dispatch_queue.unroutable_since` — when the job first read unroutable.
 *   Persisted rather than in-memory so a restart mid-grace resumes the same
 *   clock instead of resetting it; an orchestrator that bounces every 90s must
 *   not be able to keep a genuinely dead job alive forever. Cleared the moment
 *   the job reads routable again.
 * - `execution_jobs.routing_reason` — the operator-facing reason, visible while
 *   the job is still queued. Cleared on recovery.
 *
 * Idempotent: each column is guarded on existence, so a re-run is a no-op.
 */
async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${column}
    ) AS exists
  `.execute(db);
  return check.rows[0]?.exists === true;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await columnExists(db, 'cluster_settings', 'unroutable_grace_ms'))) {
    await sql`ALTER TABLE public.cluster_settings ADD COLUMN unroutable_grace_ms INTEGER`.execute(
      db,
    );
  }
  if (!(await columnExists(db, 'dispatch_queue', 'unroutable_since'))) {
    await sql`ALTER TABLE public.dispatch_queue ADD COLUMN unroutable_since TIMESTAMPTZ`.execute(
      db,
    );
  }
  if (!(await columnExists(db, 'execution_jobs', 'routing_reason'))) {
    await sql`ALTER TABLE public.execution_jobs ADD COLUMN routing_reason TEXT`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS routing_reason`.execute(db);
  await sql`ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS unroutable_since`.execute(db);
  await sql`ALTER TABLE public.cluster_settings DROP COLUMN IF EXISTS unroutable_grace_ms`.execute(
    db,
  );
}
