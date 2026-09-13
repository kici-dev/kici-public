import { type Kysely, sql } from 'kysely';

/**
 * Add `workflow_registrations.default_branch text` (nullable).
 *
 * A `__schedule_fire` run executes the default branch's lock file, so the
 * default branch IS that run's branch — which is what a branch-restricted
 * context needs in order to accept it. The value is already computed at
 * registration time from the webhook payload (the default-branch-push check),
 * it was simply never persisted, so a scheduled run had no branch to present.
 *
 * NULLABLE with no default, deliberately. The default branch is knowable only
 * from a webhook payload, so there is nothing to backfill a pre-existing row
 * with: a registration written before this migration reads NULL until its
 * repo's next default-branch push re-registers it. The dispatch path reads NULL
 * as "no branch" and the context branch gate then rejects with its honest
 * named-cause verdict — a DEFAULT would instead invent a branch the
 * registration never proved, which is exactly the confusion this whole column
 * exists to end.
 *
 * Idempotent: a re-run on a DB that already has the column is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const colCheck = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'workflow_registrations'
         AND column_name = 'default_branch'
    ) AS exists
  `.execute(db);
  if (colCheck.rows[0]?.exists) return;

  await sql`
    ALTER TABLE public.workflow_registrations
      ADD COLUMN default_branch text
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.workflow_registrations DROP COLUMN IF EXISTS default_branch
  `.execute(db);
}
