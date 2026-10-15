import { type Kysely, sql } from 'kysely';

/**
 * Add `check_run_tracking.terminal_sent_at`.
 *
 * `check_run_id` is written at create time, while the check run is `queued`, so it proves
 * creation, never completion. Without a completion signal a check run stuck `queued` on the
 * provider is indistinguishable from provider lag, so a check-run poll timeout was
 * unattributable.
 *
 * Stamped only after the provider accepts a `completed` update. Best-effort like every write on
 * this table (a tracking write must never break check-run reporting), so NULL means "no record
 * of sending it", not "never sent". Idempotent.
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
