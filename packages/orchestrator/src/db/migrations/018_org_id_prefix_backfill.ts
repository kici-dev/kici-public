import { type Kysely, sql } from 'kysely';

/**
 * Prefix every orchestrator-side tenant string with `org_` to align
 * with Platform's prefixed canonical org ID format (`org_<12-char>`).
 *
 * Migration 017 widened the column types but deliberately left rows
 * un-backfilled, reasoning that pre-migration runtime data could be
 * orphaned and regenerated on the next deploy. That works for
 * historical artefacts (execution_runs, event_log, access_log) but
 * NOT for tenant-state tables the orchestrator needs to recognise the
 * staging org at routing time (`sources`, `generic_webhook_sources`,
 * `workflow_registrations`, `org_settings`) and the env-config tables
 * referenced from runtime requests (`environments`,
 * `environment_bindings`, `environment_source_overrides`,
 * `environment_variables`).
 *
 * This migration walks both column families — `org_id` and
 * `customer_id` — and applies the same `'org_' || value` prefix to
 * every row whose value is not the platform-admin sentinel
 * `kici-admin`. After it runs, the orchestrator's `WHERE org_id = $1`
 * / `WHERE customer_id = $1` filters match the prefixed canonical IDs
 * that Platform now sends.
 *
 * Idempotency: the `WHERE NOT LIKE 'org\\_%'` guard makes the
 * migration a no-op on rows already prefixed (e.g. a re-run after a
 * fresh deploy populated some rows already), so applying it twice is
 * safe.
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

const CUSTOMER_ID_TABLES = [
  'sources',
  'generic_webhook_sources',
  'workflow_registrations',
  'org_settings',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of ORG_ID_TABLES) {
    await sql
      .raw(
        `UPDATE public.${table} SET org_id = 'org_' || org_id ` +
          `WHERE org_id <> 'kici-admin' AND org_id NOT LIKE 'org\\_%' ESCAPE '\\'`,
      )
      .execute(db);
  }
  for (const table of CUSTOMER_ID_TABLES) {
    await sql
      .raw(
        `UPDATE public.${table} SET customer_id = 'org_' || customer_id ` +
          `WHERE customer_id <> 'kici-admin' AND customer_id NOT LIKE 'org\\_%' ESCAPE '\\'`,
      )
      .execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of CUSTOMER_ID_TABLES) {
    await sql
      .raw(
        `UPDATE public.${table} SET customer_id = substring(customer_id from 5) ` +
          `WHERE customer_id LIKE 'org\\_%' ESCAPE '\\'`,
      )
      .execute(db);
  }
  for (const table of ORG_ID_TABLES) {
    await sql
      .raw(
        `UPDATE public.${table} SET org_id = substring(org_id from 5) ` +
          `WHERE org_id LIKE 'org\\_%' ESCAPE '\\'`,
      )
      .execute(db);
  }
}
