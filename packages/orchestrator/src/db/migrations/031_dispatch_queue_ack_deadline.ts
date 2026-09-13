import { type Kysely, sql } from 'kysely';

/**
 * Add `dispatch_queue.ack_deadline TIMESTAMPTZ` and
 * `dispatch_queue.ack_agent_id TEXT` persisting the per-dispatch
 * acknowledgment deadline for HA-safe lost-dispatch detection.
 *
 * The dispatcher stamps both when a job.dispatch is sent and clears them
 * when the agent answers (job.ack / job.reject / job.status running). A
 * `dispatched` row past its deadline is requeued — by the owning coord's
 * in-memory timer, or by the leader-gated sweep
 * (`Dispatcher.sweepExpiredAckDeadlines`) when the owning coord crashed.
 * On coord boot, `Dispatcher.recoverState()` re-arms timers from the
 * persisted deadlines.
 *
 * Idempotent: re-running on a DB that already has either column is a no-op.
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

  if (!(await colExists('ack_deadline'))) {
    await sql`
      ALTER TABLE public.dispatch_queue
        ADD COLUMN ack_deadline TIMESTAMPTZ
    `.execute(db);
  }

  if (!(await colExists('ack_agent_id'))) {
    await sql`
      ALTER TABLE public.dispatch_queue
        ADD COLUMN ack_agent_id TEXT
    `.execute(db);
  }

  // Partial index supports the leader-gated sweep's
  // `WHERE status='dispatched' AND ack_deadline < now()`.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_dispatch_queue_ack_deadline
      ON public.dispatch_queue (ack_deadline)
      WHERE ack_deadline IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.idx_dispatch_queue_ack_deadline`.execute(db);
  await sql`ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS ack_agent_id`.execute(db);
  await sql`ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS ack_deadline`.execute(db);
}
