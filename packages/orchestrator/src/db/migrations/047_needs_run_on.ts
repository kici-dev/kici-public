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
 * Idempotent (column-exists guarded); existing rows are preserved.
 */

// Mirrors the engine `always` status set (TERMINAL_JOB_STATES), so a backfilled `run` edge keeps
// its run-regardless semantics.
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

// Postgres rejects bound parameters in a DDL DEFAULT, so the default is inlined. Safe: it is a
// compile-time constant and JSON.stringify emits no single quotes.
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
