import { type Kysely, sql } from 'kysely';

/**
 * Add `held_runs.posted_pending_check boolean` — whether this hold's pending
 * `KiCI Security` check actually reached the provider.
 *
 * `postCheckStatus` CREATES the named check run when it finds none, so
 * terminalizing a check the hold never posted does not close anything: it puts
 * a completed `KiCI Security` run on a commit that had none. Whether a hold
 * posted one was derived from the row's SHAPE, which answers what the code
 * INTENDED — a post that the provider refused, or that no check poster was in
 * reach to attempt, leaves a shape that says "posted" and a commit that has
 * nothing. The column records what happened instead of what was meant.
 *
 * Nullable, with no default, and the three values are distinct:
 *
 * - `true` — the post returned successfully. The hold owns the check.
 * - `false` — no post was attempted, or one was attempted and failed. Nothing
 *   to terminalize; a settle would fabricate.
 * - `null` — the row predates this column, so nothing recorded either way. The
 *   shape derivation still answers for it. A `false` DEFAULT would instead
 *   declare every hold pending at deploy time un-posted and strand the checks
 *   they really do have.
 *
 * Idempotent: a re-run on a DB that already has the column is a no-op.
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
