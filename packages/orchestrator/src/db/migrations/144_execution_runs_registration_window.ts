import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.registration_window_instance_id TEXT NULL` — the
 * coordinator whose dispatch pipeline still has jobs to register for this run.
 *
 * A run is registered before all its jobs exist (with only its source-pack build job, or none
 * ahead of its dispatch loop). The coordinator running that pipeline holds an in-memory token
 * that stops its own completion check from finalizing the run early.
 *
 * A sibling coordinator whose agent claims one of the jobs rehydrates the run from the DB with
 * no token, and would finalize it once its known jobs are terminal: on a build job alone, a
 * green run in which nothing ran. This column is the token's durable form: the owner writes
 * its instance id on its first token and clears it on its last, and every finalization path
 * defers while it names a live sibling.
 *
 * Nullable, no default: NULL means no registration window is open (including older rows). A
 * dead holder's id reads as no window; liveness comes from `cluster_instances`, as for
 * `dispatch_queue.owner_instance_id`.
 *
 * Idempotent: the add is guarded on existence and the drop uses IF EXISTS.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = 'registration_window_instance_id'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists === true) return;

  await sql`
    ALTER TABLE public.execution_runs
      ADD COLUMN registration_window_instance_id TEXT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS registration_window_instance_id
  `.execute(db);
}
