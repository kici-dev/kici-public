import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.status_epoch` (integer, NOT NULL, default 0).
 *
 * The run's status generation. It starts at 0, and the tracker raises it each
 * time a run leaves a terminal status: a run failed before a job it had already
 * dispatched reported in, and the run continues. Every `execution.status` frame
 * carries it, so the Platform can keep a finished run finished against a
 * non-terminal frame that arrives late, and still follow a real reopen.
 *
 * A constant default adds the column without rewriting the table, and every
 * existing row reads 0: none of them was reopened under this counter.
 *
 * Idempotent: guarded on the column's existence, so re-running is a no-op.
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
