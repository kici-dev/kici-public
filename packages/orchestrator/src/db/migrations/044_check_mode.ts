import { type Kysely, sql } from 'kysely';

/**
 * Add idempotent check-mode columns:
 *
 * - `execution_runs.check_mode text` — the run's mode (`apply` | `check` |
 *   `check-fail-on-drift`). NULL means a legacy/apply run.
 * - `execution_steps.check_outcome text` — the per-step `CheckStepOutcome`
 *   (`skipped` | `applied` | `declined` | `dry-run` | `no_check`). NULL when
 *   the step ran without a check mode.
 * - `execution_steps.drift_summary text` — the human-readable `summarize(drift)`
 *   line. NULL when no drift.
 * - `execution_steps.drift jsonb` — the structured drift value. NULL when no drift.
 *
 * All nullable. Idempotent: re-running on a DB that already has the columns is
 * a no-op.
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
  if (!(await colExists(db, 'execution_runs', 'check_mode'))) {
    await sql`ALTER TABLE public.execution_runs ADD COLUMN check_mode text`.execute(db);
  }
  if (!(await colExists(db, 'execution_steps', 'check_outcome'))) {
    await sql`ALTER TABLE public.execution_steps ADD COLUMN check_outcome text`.execute(db);
  }
  if (!(await colExists(db, 'execution_steps', 'drift_summary'))) {
    await sql`ALTER TABLE public.execution_steps ADD COLUMN drift_summary text`.execute(db);
  }
  if (!(await colExists(db, 'execution_steps', 'drift'))) {
    await sql`ALTER TABLE public.execution_steps ADD COLUMN drift jsonb`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_steps DROP COLUMN IF EXISTS drift`.execute(db);
  await sql`ALTER TABLE public.execution_steps DROP COLUMN IF EXISTS drift_summary`.execute(db);
  await sql`ALTER TABLE public.execution_steps DROP COLUMN IF EXISTS check_outcome`.execute(db);
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS check_mode`.execute(db);
}
