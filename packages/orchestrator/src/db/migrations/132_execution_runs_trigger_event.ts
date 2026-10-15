import { type Kysely, sql } from 'kysely';

/**
 * Add `execution_runs.trigger_event`: the event type that started the run (`push`, `pr:open`,
 * `schedule`, …). The git credential relay evaluates a context's `triggerTypeFilters` against it,
 * which needs the persisted value, not the tracker's in-memory copy.
 *
 * Nullable, no default: an older row has no recorded trigger and no cluster-wide value can stand
 * in. An unknown trigger fails a `triggerTypeFilters` rule closed, withholding the credential.
 * Idempotent.
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
