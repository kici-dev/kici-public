import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_jobs.precursor_result`: the payload a precursor job (source-pack build, init,
 * dynamic eval) reports on its terminal `job.status`, readable by any coordinator.
 *
 * The dispatch queue is cluster-wide, so an agent on a sibling coordinator may run the job and
 * receive its terminal frame, which the awaiting coordinator never sees. The shared row is their
 * channel; without the result (a build's `buildComplete` marker, an init's resolved fields, a
 * dynamic eval's generated jobs) the awaiting coordinator waited out its build timeout on a
 * successful build.
 *
 * Nullable, no default: NULL means "no precursor payload" (every ordinary job and older row).
 * Idempotent.
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
