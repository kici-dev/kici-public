import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.failure_class` — the reason a terminal run failed
 * (`RunFailureClass`: never_started / timed_out / dead_orchestrator /
 * step_failure / cancelled). Derived at run completion from the terminal job
 * statuses (the status column alone can't carry it — timed_out and step_failure
 * both collapse to `failed`). Plain text, value-constrained by the enum in code,
 * like `status`. NULL for success / not-yet-terminal runs. Nullable, no backfill,
 * idempotent.
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
  if (!(await colExists(db, 'execution_runs', 'failure_class'))) {
    await sql`ALTER TABLE public.execution_runs ADD COLUMN failure_class text`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS failure_class`.execute(db);
}
