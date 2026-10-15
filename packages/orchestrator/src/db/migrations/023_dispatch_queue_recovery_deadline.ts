import { type Kysely, sql } from 'kysely';

/**
 * Persists per-job agent-disconnect recovery state, so a coord crash between starting the
 * recovery timer and its firing cannot leave a `recovering` job with no deadline or owning
 * agent, lingering forever.
 *
 * A leader-gated sweep (`Dispatcher.sweepExpiredRecoveries`) fails rows matching
 * `WHERE status='recovering' AND recovery_deadline < now()`; on coord boot
 * `Dispatcher.recoverState()` re-creates the timers from the persisted deadlines.
 *
 * Idempotent: an existing column is a no-op.
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

  // Serves the leader-gated sweep.
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
