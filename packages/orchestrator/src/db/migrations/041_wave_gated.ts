import { type Kysely, sql } from 'kysely';

/**
 * Add the rolling fan-out wave-gate columns:
 *
 * - `execution_jobs.wave_gated boolean NOT NULL DEFAULT false` — when a fan-out
 *   job declares `maxParallel`, children beyond the sliding window are persisted
 *   `wave_gated=true` (held, not enqueued). The dispatch loop skips them; the
 *   wave-scheduler clears the flag one-per-terminal as siblings complete (or, on
 *   `failFast`, skips the held remainder).
 * - `execution_jobs.wave_max_parallel int` / `wave_fail_fast boolean` — the
 *   base's wave policy, stamped on every fan-out child so the wave-scheduler can
 *   read it at terminal time without re-fetching the lock file (the tracker has
 *   no lock access). NULL for any job not part of a bounded wave.
 *
 * A composite index on (run_id, base_job_name, wave_gated) supports the
 * wave-scheduler's "next held sibling of this base" lookups.
 *
 * Idempotent: re-running on a DB that already has the columns is a no-op.
 */
async function colExists(db: Kysely<unknown>, table: string, name: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${name}
    ) AS exists
  `.execute(db);
  return result.rows[0]?.exists ?? false;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await colExists(db, 'execution_jobs', 'wave_gated'))) {
    await sql`ALTER TABLE public.execution_jobs ADD COLUMN wave_gated boolean NOT NULL DEFAULT false`.execute(
      db,
    );
  }
  if (!(await colExists(db, 'execution_jobs', 'wave_max_parallel'))) {
    await sql`ALTER TABLE public.execution_jobs ADD COLUMN wave_max_parallel integer`.execute(db);
  }
  if (!(await colExists(db, 'execution_jobs', 'wave_fail_fast'))) {
    await sql`ALTER TABLE public.execution_jobs ADD COLUMN wave_fail_fast boolean`.execute(db);
  }
  await sql`
    CREATE INDEX IF NOT EXISTS idx_execution_jobs_wave
      ON public.execution_jobs (run_id, base_job_name, wave_gated)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.idx_execution_jobs_wave`.execute(db);
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS wave_fail_fast`.execute(db);
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS wave_max_parallel`.execute(db);
  await sql`ALTER TABLE public.execution_jobs DROP COLUMN IF EXISTS wave_gated`.execute(db);
}
