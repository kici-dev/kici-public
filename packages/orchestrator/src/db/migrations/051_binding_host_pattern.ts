import { type Kysely, sql } from 'kysely';

/**
 * Add a per-host dimension to environment secret bindings:
 *
 * - `environment_bindings.host_pattern text NOT NULL DEFAULT '**'` — the host
 *   selector a binding applies to (exact / glob / regex, matched against a
 *   fan-out child's agentId / hostname / labels). `'**'` matches every host, so
 *   existing rows are backfilled to `'**'` and keep their fleet-wide behaviour.
 * - The binding unique key widens from `(environment_id, scope_pattern)` to
 *   `(environment_id, scope_pattern, host_pattern)` so the same scope can carry
 *   distinct per-host selectors.
 *
 * Idempotent: re-running on a DB that already has the column / index is a no-op.
 * Additive — staging data is preserved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.environment_bindings
    ADD COLUMN IF NOT EXISTS host_pattern text NOT NULL DEFAULT '**'`.execute(db);
  // Replace the old 2-column unique with a 3-column unique that includes host_pattern.
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
