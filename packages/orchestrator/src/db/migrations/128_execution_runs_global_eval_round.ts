import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.is_global_eval_round boolean NOT NULL DEFAULT false` —
 * the structural marker for a run row that records a global evaluation round
 * rather than a workflow.
 *
 * The re-run path must recognise such a run: re-running it re-executes the
 * evaluation, not a workflow. The only discriminator available to it otherwise
 * is the round job's `__globaleval__` name prefix, which a customer workflow
 * may carry — a name a customer chooses cannot decide which code path a re-run
 * takes. A column stamped where the round failure is recorded is
 * collision-proof.
 *
 * `NOT NULL DEFAULT false` because the question has exactly two answers: every
 * pre-existing row is an ordinary run, and there is no third "unknown" reading
 * a null would carry.
 *
 * Idempotent: the add is guarded on existence and the drop uses IF EXISTS, so a
 * re-run is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = 'is_global_eval_round'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists === true) return;

  await sql`
    ALTER TABLE public.execution_runs
      ADD COLUMN is_global_eval_round BOOLEAN NOT NULL DEFAULT FALSE
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS is_global_eval_round
  `.execute(db);
}
