import { type Kysely, sql } from 'kysely';

/**
 * Add `dispatch_queue.dispatch_attempts`: how often a job returned to `pending` after a failed
 * delivery (job.reject, or a scaler-managed agent disconnecting before start). The dispatcher
 * fails the job at MAX_DISPATCH_ATTEMPTS, bounding requeue loops; `expires_at` stays the
 * time-based backstop. Idempotent.
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
