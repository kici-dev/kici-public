import { type Kysely, sql } from 'kysely';

/**
 * Add `check_run_tracking.terminal_sent_at` (nullable timestamptz).
 *
 * `check_run_id` is written at CREATE time, while the check run is still
 * `queued`, so it proves creation and never completion. Without a completion
 * signal a check run stuck `queued` on the provider is indistinguishable from
 * the provider simply lagging, which is what made a check-run poll timeout
 * unattributable: nothing on our side recorded whether the terminal update had
 * been sent at all.
 *
 * Stamped only after the provider accepts a `completed` update. Nullable and
 * best-effort like every write on this table — a tracking write must never
 * break check-run reporting — so NULL means "we have no record of sending it",
 * not "it was never sent".
 *
 * Idempotent: guarded on column existence; a re-run on a DB that already has
 * the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'check_run_tracking'
         AND column_name = 'terminal_sent_at'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists) return;
  await sql`ALTER TABLE public.check_run_tracking ADD COLUMN terminal_sent_at TIMESTAMPTZ`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.check_run_tracking DROP COLUMN IF EXISTS terminal_sent_at`.execute(
    db,
  );
}
