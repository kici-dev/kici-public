import { type Kysely, sql } from 'kysely';

/**
 * Widen every orchestrator-side `org_id varchar(12)` column to
 * `varchar(16)` to match Platform's new prefixed canonical org ID
 * format (`org_<12-char NanoID>`).
 *
 * The orchestrator receives org IDs from Platform via the WS relay —
 * it does not generate them. After Platform's migration 018 deploys,
 * every new run/event/etc. routed through this orchestrator carries
 * the prefixed 16-char ID. The orchestrator just stores whatever
 * string it receives.
 *
 * No row backfill on this side: pre-migration rows carry un-prefixed
 * 12-char values and reference Platform org IDs that are now obsolete.
 * They are orphans by design — once Platform's migration runs, the
 * dashboard queries the orchestrator API with the new prefixed IDs
 * and the orchestrator's `WHERE org_id = $1` filter naturally hides
 * the old rows. Staging E2E regenerates fresh rows during the next
 * test run.
 *
 * Tables widened: `access_log`, `environment_bindings`,
 * `environment_source_overrides`, `environment_variables`,
 * `environments`, `event_log`, `held_runs`, `scoped_secrets`.
 *
 * Not touched: `org_settings.customer_id` and
 * `generic_webhook_sources.customer_id` (already `text` /
 * `varchar(255)` — wide enough), `sources.customer_id` (varchar(255)
 * — wide enough).
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
