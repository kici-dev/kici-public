import { type Kysely, sql } from 'kysely';

/**
 * Add `dispatch_queue.dispatch_attempts INT NOT NULL DEFAULT 0`.
 *
 * Counts how many times a job has been returned to `pending` for
 * re-dispatch after a failed delivery attempt (agent sent job.reject, or
 * a scaler-managed agent disconnected before the job started). The
 * dispatcher fails the job permanently once the counter reaches
 * MAX_DISPATCH_ATTEMPTS, bounding requeue loops; `expires_at` remains the
 * time-based backstop.
 *
 * Idempotent: re-running on a DB that already has the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'dispatch_queue'
         AND column_name = 'dispatch_attempts'
    ) AS exists
  `.execute(db);
  if (!(result.rows[0]?.exists ?? false)) {
    await sql`
      ALTER TABLE public.dispatch_queue
        ADD COLUMN dispatch_attempts INT NOT NULL DEFAULT 0
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS dispatch_attempts
  `.execute(db);
}
