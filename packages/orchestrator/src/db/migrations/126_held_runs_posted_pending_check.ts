import { type Kysely, sql } from 'kysely';

/**
 * Add `held_runs.posted_pending_check boolean` — whether this hold's pending
 * `KiCI Security` check actually reached the provider.
 *
 * `postCheckStatus` CREATES the named check run when it finds none, so terminalizing a check
 * the hold never posted fabricates a completed `KiCI Security` run. The row's SHAPE only says
 * what the code intended: a refused post, or one no check poster could attempt, still reads
 * "posted". This column records what happened.
 *
 * Nullable, no default:
 *
 * - `true` — the post succeeded; the hold owns the check.
 * - `false` — no post, or a failed one. Nothing to terminalize; a settle would fabricate.
 * - `null` — the row predates this column; the shape derivation still answers for it. A `false`
 *   DEFAULT would mark every hold pending at deploy time un-posted and strand its real check.
 *
 * Idempotent.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'held_runs'
         AND column_name = 'posted_pending_check'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.held_runs
      ADD COLUMN posted_pending_check boolean
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.held_runs DROP COLUMN IF EXISTS posted_pending_check
  `.execute(db);
}
