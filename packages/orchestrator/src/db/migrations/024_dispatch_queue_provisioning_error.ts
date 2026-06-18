import { type Kysely, sql } from 'kysely';

/**
 * Add `dispatch_queue.last_provisioning_error TEXT` recording the most
 * recent scaler spawn-failure detail for a queued job.
 *
 * When the scaler fails to provision an agent for a job (e.g. the agent
 * process exits with "spawn node ENOENT", or a container backend rejects
 * the run), a `scaler.failed` event bound to the job writes the failure
 * detail into this column. The queue-timeout reaper reads it so the job's
 * eventual failure surfaces the real provisioning cause instead of a bare
 * "no agent available" timeout. The column is cleared on dispatch and is
 * NULL whenever no provisioning failure has been recorded.
 *
 * Idempotent: re-running on a DB that already has the column is a no-op.
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
