import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.registration_window_instance_id TEXT NULL` — the
 * coordinator whose dispatch pipeline still has jobs to register for this run.
 *
 * A run is registered before all of its jobs exist: with its source-pack build
 * job alone, or with no jobs at all ahead of its dispatch loop, and the real
 * jobs land only once the build finishes or every dispatch has returned. The
 * coordinator running that pipeline holds an in-memory token that keeps its
 * own completion check from finalizing the run on the jobs registered so far.
 *
 * The dispatch queue is cluster-wide, so a job may be claimed by an agent
 * connected to a sibling coordinator, and that sibling rehydrates the run from
 * the database when the agent reports on it. The sibling has no token, so
 * once the jobs it knows about are terminal it finalizes the run — on a build
 * job alone, that is a green run in which nothing ran. This column is the
 * token's durable form: the owner writes its instance id when it takes its
 * first token and clears it when it drops its last, and every finalization
 * path defers while the column names a live sibling.
 *
 * Nullable, with no default: NULL means "no coordinator has a registration
 * window open", which is true of every run whose owner released its window
 * and of every row written before this column existed. A dead holder's id
 * reads as no window at all — liveness comes from `cluster_instances`, the
 * same way the dispatch plane reads `dispatch_queue.owner_instance_id`.
 *
 * Idempotent: the add is guarded on existence and the drop uses IF EXISTS, so a
 * re-run is a no-op.
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
