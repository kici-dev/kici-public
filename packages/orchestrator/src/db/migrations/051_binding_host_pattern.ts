import { type Kysely, sql } from 'kysely';

/**
 * Per-host environment secret bindings:
 *
 * - `host_pattern` — exact / glob / regex host selector, matched against a fan-out child's
 *   agentId / hostname / labels. Existing rows backfill to `'**'` (every host), keeping their
 *   fleet-wide behaviour.
 * - The unique key widens to `(environment_id, scope_pattern, host_pattern)`, so one scope can
 *   carry distinct per-host selectors.
 *
 * Idempotent and additive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.environment_bindings
    ADD COLUMN IF NOT EXISTS host_pattern text NOT NULL DEFAULT '**'`.execute(db);
  await sql`ALTER TABLE public.environment_bindings
    DROP CONSTRAINT IF EXISTS environment_bindings_env_id_scope_unique`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS environment_bindings_env_scope_host_uniq
    ON public.environment_bindings (environment_id, scope_pattern, host_pattern)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS public.environment_bindings_env_scope_host_uniq`.execute(db);
  await sql`ALTER TABLE public.environment_bindings
    DROP COLUMN IF EXISTS host_pattern`.execute(db);
  await sql`ALTER TABLE public.environment_bindings
    ADD CONSTRAINT environment_bindings_env_id_scope_unique UNIQUE (environment_id, scope_pattern)`.execute(
    db,
  );
}
