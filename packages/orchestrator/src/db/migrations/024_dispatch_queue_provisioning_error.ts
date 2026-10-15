import { type Kysely, sql } from 'kysely';

/**
 * `dispatch_queue.last_provisioning_error`: the latest scaler spawn-failure detail for a queued
 * job, written by a job-bound `scaler.failed` event (e.g. "spawn node ENOENT"). The
 * queue-timeout reaper surfaces it instead of a bare "no agent available" timeout. Cleared on
 * dispatch; NULL when no failure is recorded.
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

  if (!(await colExists('last_provisioning_error'))) {
    await sql`
      ALTER TABLE public.dispatch_queue
        ADD COLUMN last_provisioning_error TEXT
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.dispatch_queue DROP COLUMN IF EXISTS last_provisioning_error
  `.execute(db);
}
