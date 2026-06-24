import { type Kysely, sql } from 'kysely';

/**
 * Add `held_runs.payload jsonb NULL` — the drift payload captured when a
 * `when: 'drift'` step-approval gate fires. Holds `{ summaryMarkdown, drift }`:
 * the author's `summarize(drift)` rendering plus the structured drift blob, so
 * the dashboard approval queue and the CLI render the computed diff the
 * operator approves. NULL for every non-drift hold.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`); additive, so staging data is
 * preserved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.held_runs
    ADD COLUMN IF NOT EXISTS payload jsonb`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.held_runs DROP COLUMN IF EXISTS payload`.execute(db);
}
