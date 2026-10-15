import { type Kysely, sql } from 'kysely';

/**
 * Add `workflow_registrations.default_branch`.
 *
 * A `__schedule_fire` run executes the default branch's lock file, so the default branch IS its
 * branch, which a branch-restricted context needs to accept it. Registration already computes it
 * from the webhook payload (the default-branch-push check); this persists it.
 *
 * NULLABLE with no default, deliberately: only a webhook payload reveals the default branch, so
 * a pre-existing row reads NULL until its repo's next default-branch push re-registers it.
 * Dispatch reads NULL as "no branch" and the context branch gate rejects with its named cause; a
 * DEFAULT would invent a branch the registration never proved. Idempotent.
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
