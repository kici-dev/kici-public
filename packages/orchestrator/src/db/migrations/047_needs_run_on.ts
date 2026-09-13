import { type Kysely, sql } from 'kysely';

/**
 * Migrate `execution_job_needs` from the binary `if_failed` policy to a
 * programmable `run_on` status-set:
 *
 * - Add `run_on text` (JSON-encoded array of upstream terminal statuses) with a
 *   default of `'["success"]'`.
 * - Backfill from the existing `if_failed`: `skip` → `["success"]`,
 *   `run` → every terminal job status.
 * - Drop `if_failed`.
 *
 * Idempotent: column-exists guarded so re-running on a DB that already has
 * `run_on` (and no `if_failed`) is a no-op. Existing rows are preserved
 * (staging data is not dropped).
 */

// Mirrors the engine keyword→status-set mapping for `always`
// (TERMINAL_JOB_STATES) so a backfilled `run` edge keeps its run-regardless
// semantics.
const ALL_TERMINAL_JSON = JSON.stringify([
  'success',
  'failed',
  'cancelled',
  'skipped',
  'timed_out_stale',
  'drift_dropped',
]);
const SUCCESS_ONLY_JSON = JSON.stringify(['success']);

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

// Postgres rejects bound parameters inside a DDL DEFAULT clause, so the
// success-only default is inlined as a single-quoted literal. The value is a
// fixed compile-time constant (never user input), and JSON.stringify produces
// no single quotes, so plain string interpolation is safe here.
const SUCCESS_ONLY_DEFAULT = `'${SUCCESS_ONLY_JSON}'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  if (!(await colExists(db, 'execution_job_needs', 'run_on'))) {
    await sql`
      ALTER TABLE public.execution_job_needs
        ADD COLUMN run_on text NOT NULL DEFAULT ${sql.raw(SUCCESS_ONLY_DEFAULT)}
    `.execute(db);
  }

  // Backfill from if_failed only while it still exists.
  if (await colExists(db, 'execution_job_needs', 'if_failed')) {
    await sql`
      UPDATE public.execution_job_needs
         SET run_on = ${ALL_TERMINAL_JSON}
       WHERE if_failed = 'run'
    `.execute(db);
    await sql`
      UPDATE public.execution_job_needs
         SET run_on = ${SUCCESS_ONLY_JSON}
       WHERE if_failed = 'skip'
    `.execute(db);
    await sql`ALTER TABLE public.execution_job_needs DROP COLUMN if_failed`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  if (!(await colExists(db, 'execution_job_needs', 'if_failed'))) {
    await sql`
      ALTER TABLE public.execution_job_needs
        ADD COLUMN if_failed text NOT NULL DEFAULT 'skip'
    `.execute(db);
  }
  if (await colExists(db, 'execution_job_needs', 'run_on')) {
    // An edge whose run_on is anything other than success-only maps back to 'run'.
    await sql`
      UPDATE public.execution_job_needs
         SET if_failed = CASE WHEN run_on = ${SUCCESS_ONLY_JSON} THEN 'skip' ELSE 'run' END
    `.execute(db);
    await sql`ALTER TABLE public.execution_job_needs DROP COLUMN run_on`.execute(db);
  }
}
