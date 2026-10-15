import { type Kysely, sql } from 'kysely';

/**
 * Add `held_runs.payload`: the `{ summaryMarkdown, drift }` captured when a `when: 'drift'`
 * step-approval gate fires, so the dashboard approval queue and the CLI render the diff the
 * operator approves. NULL for every non-drift hold. Idempotent and additive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.held_runs
    ADD COLUMN IF NOT EXISTS payload jsonb`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.held_runs DROP COLUMN IF EXISTS payload`.execute(db);
}
