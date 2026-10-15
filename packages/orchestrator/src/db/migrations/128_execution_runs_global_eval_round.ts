import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.is_global_eval_round boolean NOT NULL DEFAULT false` —
 * the structural marker for a run row that records a global evaluation round
 * rather than a workflow.
 *
 * Re-running such a run re-executes the evaluation, not a workflow. The only
 * other discriminator is the round job's `__globaleval__` name prefix, which a
 * customer workflow may carry, so a customer-chosen name would pick the re-run
 * code path; a column stamped where the round failure is recorded is
 * collision-proof.
 *
 * `NOT NULL DEFAULT false`: every pre-existing row is an ordinary run, and no
 * third "unknown" answer exists for a null to carry. Idempotent.
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
