import { type Kysely, sql } from 'kysely';

/**
 * Prefix every orchestrator-side tenant string with `org_` to align
 * with Platform's prefixed canonical org ID format (`org_<12-char>`).
 *
 * Migration 017 widened the columns but left rows un-backfilled, which is
 * fine for historical artefacts (execution_runs, event_log, access_log) but
 * not for tenant-state tables the orchestrator resolves the org from at
 * routing time (`sources`, `generic_webhook_sources`,
 * `workflow_registrations`, `org_settings`) or the env-config tables runtime
 * requests reference (`environments`, `environment_bindings`,
 * `environment_source_overrides`, `environment_variables`).
 *
 * Prefixes both column families (`org_id`, `customer_id`) with `'org_'`,
 * except the platform-admin sentinel `kici-admin`, so `WHERE org_id = $1` /
 * `WHERE customer_id = $1` match the prefixed IDs Platform sends.
 *
 * Idempotent: the `NOT LIKE 'org\\_%'` guard skips already-prefixed rows.
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
