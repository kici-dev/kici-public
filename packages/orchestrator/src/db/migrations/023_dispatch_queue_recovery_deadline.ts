import { type Kysely, sql } from 'kysely';

/**
 * Add `dispatch_queue.recovery_deadline TIMESTAMPTZ` and
 * `dispatch_queue.recovery_agent_id TEXT` columns persisting per-job
 * recovery state for HA-safe agent-disconnect handling.
 *
 * `Dispatcher.recoveringJobs` previously held the timer handle, agent
 * ID, and deadline entirely in process memory. A coord crash between
 * starting the timer and it firing dropped the timer; the replacement
 * coord saw the row as `status='recovering'` but had no record of when
 * the deadline expired or which agent owned the job. Jobs lingered
 * forever.
 *
 * The new columns make the deadline durable. A leader-gated sweep
 * (`Dispatcher.sweepExpiredRecoveries`) scans
 * `WHERE status='recovering' AND recovery_deadline < now()` and marks
 * each row failed; on coord boot, `Dispatcher.recoverState()`
 * hydrates the in-memory Map by re-creating timers from the persisted
 * deadlines.
 *
 * Idempotent: re-running on a DB that already has either column is a
 * no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colExists = async (name: string): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'dispatch_queue'
           AND column_name = ${name}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  if (!(await colExists('recovery_deadline'))) {
    await sql`
      ALTER TABLE public.dispatch_queue
        ADD COLUMN recovery_deadline TIMESTAMPTZ
    `.execute(db);
  }

  if (!(await colExists('recovery_agent_id'))) {
    await sql`
      ALTER TABLE public.dispatch_queue
        ADD COLUMN recovery_agent_id TEXT
    `.execute(db);
  }

  // Partial index supports the leader-gated sweep's
  // `WHERE status='recovering' AND recovery_deadline < now()`.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_recovery_deadline
      ON public.dispatch_queue (recovery_deadline)
      WHERE recovery_deadline IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.idx_dispatch_queue_recovery_deadline`.execute(db);
  await sql`
    ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS recovery_agent_id
  `.execute(db);
  await sql`
    ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS recovery_deadline
  `.execute(db);
}
