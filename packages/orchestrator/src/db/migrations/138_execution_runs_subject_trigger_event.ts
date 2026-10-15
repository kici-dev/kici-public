import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.subject_trigger_event`.
 *
 * A re-run records `trigger_event: 'rerun'`, correct for the dashboard's and the git credential
 * relay's trigger-type filters, but with no pull-request dimension the OIDC subject fell back to
 * the branch shape: re-running a fork pull request minted the identity of a trusted push to the
 * same base branch, the collision migration 137 broke.
 *
 * This column carries the ORIGINAL run's event forward for that purpose only;
 * `buildIdTokenSubject` is its only reader and `trigger_event` is untouched.
 *
 * Nullable, no default, deliberately NOT backfilled: NULL means "use `trigger_event`", so a
 * legacy row keeps the subject it already mints. A backfill would guess which event a
 * pre-upgrade re-run inherited, and a wrong guess changes an identity a customer's cloud trust
 * policy pins. Idempotent.
 */
const COLUMN = 'subject_trigger_event';

export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = ${COLUMN}
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists === true) return;

  await sql`
    ALTER TABLE public.execution_runs
      ADD COLUMN ${sql.raw(COLUMN)} TEXT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS ${sql.raw(COLUMN)}
  `.execute(db);
}
