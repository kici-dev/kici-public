import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.trigger_event TEXT NULL` — the event type that started
 * the run (`push`, `pr:open`, `schedule`, …).
 *
 * The tracker has always carried this value in memory and relayed it to the
 * dashboard, but never persisted it. The git credential relay needs it: it
 * evaluates a named context's protection rules against the run, and a context
 * may restrict which trigger types may use it (`triggerTypeFilters`). Without
 * the recorded value that rule cannot be evaluated at all.
 *
 * Nullable, with no default: a row written before this column existed has no
 * recorded trigger, and no cluster-wide value could stand in for one. A run
 * whose trigger is unknown fails a `triggerTypeFilters` rule closed, which is
 * the correct direction — a credential is withheld rather than granted on a
 * rule nobody could check.
 *
 * Idempotent: the add is guarded on existence and the drop uses IF EXISTS, so a
 * re-run is a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const check = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = 'trigger_event'
    ) AS exists
  `.execute(db);
  if (check.rows[0]?.exists === true) return;

  await sql`
    ALTER TABLE public.execution_runs
      ADD COLUMN trigger_event TEXT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE public.execution_runs DROP COLUMN IF EXISTS trigger_event
  `.execute(db);
}
