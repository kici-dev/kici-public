import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.cancel_force BOOLEAN` (nullable, no default).
 *
 * TRUE once a forced cancel reached the run. The leader's stuck-cancelling
 * sweep reads it to re-send a cancel that did not complete with `force` set,
 * so a forced cancel whose first forward to a sibling coordinator was lost is
 * not re-sent as a graceful one. NULL (every existing row, and every run no
 * forced cancel reached) re-sends gracefully. No backfill: nothing recorded
 * whether an earlier cancel was forced.
 *
 * Idempotent: a re-run on a DB that already has the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = 'cancel_force'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.execution_runs
      ADD COLUMN cancel_force BOOLEAN
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS cancel_force
  `.execute(db);
}
