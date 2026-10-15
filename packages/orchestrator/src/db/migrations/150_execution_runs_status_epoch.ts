import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.status_epoch`: the run's status generation. The tracker raises it each time
 * a run leaves a terminal status (it failed before an already-dispatched job reported in, and
 * continues). Every `execution.status` frame carries it, so the Platform keeps a finished run
 * finished against a late non-terminal frame and still follows a real reopen.
 *
 * The constant default 0 adds the column without a table rewrite; no existing row was reopened
 * under this counter. Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = 'status_epoch'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.execution_runs ADD COLUMN status_epoch INTEGER NOT NULL DEFAULT 0`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS status_epoch`.execute(db);
}
