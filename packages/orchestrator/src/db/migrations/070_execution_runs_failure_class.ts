import { type Kysely, sql } from 'kysely';

/**
 * `execution_runs.failure_class` (`RunFailureClass`: never_started / timed_out /
 * dead_orchestrator / step_failure / cancelled), derived at completion from the terminal
 * job statuses: `status` collapses timed_out and step_failure into `failed`. Plain text,
 * constrained by the enum in code. NULL for success / non-terminal runs. No backfill,
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
