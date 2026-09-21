import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_jobs.precursor_result JSONB NULL` — the payload a precursor
 * job (source-pack build, init, dynamic eval) reports on its terminal
 * `job.status`, persisted so a coordinator other than the one whose agent ran
 * the job can read it back.
 *
 * The dispatch queue is cluster-wide: a job one coordinator dispatched may be
 * claimed by an agent connected to a sibling coordinator. The sibling receives
 * the agent's terminal frame; the coordinator awaiting the job never does. The
 * shared row is the channel between them, and until this column existed the
 * row carried the status but not the result — a build's `buildComplete`
 * marker, an init's resolved fields, a dynamic eval's generated jobs — so the
 * awaiting coordinator waited out its build timeout on a build that had
 * succeeded.
 *
 * Nullable, with no default: NULL means "this job reported no precursor
 * payload", which is true of every ordinary job and of every row written
 * before this column existed.
 *
 * Idempotent: the add is guarded on existence and the drop uses IF EXISTS, so a
 * re-run is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_jobs'
         AND column_name = 'precursor_result'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists === true) return;

  await sql`
    ALTER TABLE public.execution_jobs
      ADD COLUMN precursor_result JSONB
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS precursor_result
  `.execute(db);
}
