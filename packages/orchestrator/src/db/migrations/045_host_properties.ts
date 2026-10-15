import { type Kysely, sql } from 'kysely';

/**
 * `host_roster.host_properties jsonb NOT NULL DEFAULT '{}'`: the typed host-vars
 * bag (`string | number | boolean` values) the agent reports at registration
 * and/or the operator declares (`kici-admin host declare --prop`). Labels stay
 * the flat-string grouping dimension; properties are a separate queryable one.
 *
 * Idempotent and additive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.host_roster
    ADD COLUMN IF NOT EXISTS host_properties jsonb NOT NULL DEFAULT '{}'::jsonb`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.host_roster DROP COLUMN IF EXISTS host_properties`.execute(db);
}
