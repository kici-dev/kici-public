import { type Kysely, sql } from 'kysely';

/**
 * Add the typed host-vars dimension to the host roster:
 *
 * - `host_roster.host_properties jsonb NOT NULL DEFAULT '{}'` — the typed
 *   property bag (`string | number | boolean` values) reported by the agent at
 *   registration and/or declared by the operator (`kici-admin host declare
 *   --prop`). Labels stay the flat-string grouping dimension; properties are
 *   the separate queryable host-vars dimension.
 *
 * Idempotent (`ADD COLUMN IF NOT EXISTS`): re-running on a DB that already has
 * the column is a no-op. Staging data is preserved (additive column).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.host_roster
    ADD COLUMN IF NOT EXISTS host_properties jsonb NOT NULL DEFAULT '{}'::jsonb`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.host_roster DROP COLUMN IF EXISTS host_properties`.execute(db);
}
