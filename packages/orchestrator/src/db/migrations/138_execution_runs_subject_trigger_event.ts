import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.subject_trigger_event TEXT`, nullable.
 *
 * A re-run records `trigger_event: 'rerun'`. That is the truthful answer for
 * the two readers that depend on it — the dashboard's trigger-type filter and
 * the git credential relay's trigger-type filters — but it carries no
 * pull-request dimension, so the OIDC subject derived from it fell back to the
 * branch shape. Re-running a fork pull request therefore minted the exact
 * identity a trusted push to the same base branch mints: the collision
 * migration 137's columns were added to break, re-opened one re-run later.
 *
 * This column carries the ORIGINAL run's event forward for that one purpose.
 * `buildIdTokenSubject` is its only reader; `trigger_event` is untouched.
 *
 * Nullable, no default, and deliberately NOT backfilled. NULL means "use
 * `trigger_event`", which is what every row written before this column existed
 * says — so a legacy row keeps the subject it already mints. A backfill would
 * have to guess which event a pre-upgrade re-run inherited, and guessing wrong
 * changes an identity a customer's cloud trust policy is already pinning.
 *
 * Idempotent: the add is guarded on existence and the drop uses IF EXISTS, so
 * a re-run is a no-op.
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
