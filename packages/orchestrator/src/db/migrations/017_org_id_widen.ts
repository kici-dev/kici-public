import { type Kysely, sql } from 'kysely';

/**
 * Widen orchestrator `org_id varchar(12)` columns to `varchar(16)` for the Platform's prefixed
 * org ID format (`org_<12-char NanoID>`, from Platform migration 018). The orchestrator only
 * stores the org IDs the WS relay delivers.
 *
 * No backfill: older rows keep obsolete un-prefixed 12-char IDs and are orphans by design;
 * the dashboard queries with prefixed IDs, so `WHERE org_id = $1` hides them.
 *
 * The `customer_id` columns (`org_settings`, `generic_webhook_sources`, `sources`) are already
 * `text` / `varchar(255)` and stay untouched.
 */

const ORG_ID_TABLES = [
  'access_log',
  'environment_bindings',
  'environment_source_overrides',
  'environment_variables',
  'environments',
  'event_log',
  'held_runs',
  'scoped_secrets',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of ORG_ID_TABLES) {
    await sql.raw(`ALTER TABLE public.${table} ALTER COLUMN org_id TYPE varchar(16)`).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ORG_ID_TABLES) {
    await sql.raw(`ALTER TABLE public.${table} ALTER COLUMN org_id TYPE varchar(12)`).execute(db);
  }
}
