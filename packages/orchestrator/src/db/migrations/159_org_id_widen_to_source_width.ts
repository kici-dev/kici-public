import { type Kysely, sql } from 'kysely';

/**
 * Widen every `org_id varchar(16)` column to `varchar(255)`, the width of the `customer_id`
 * column on `sources`, `generic_webhook_sources` and `remote_sources`.
 *
 * A Platform org id fits in 16 characters, but a standalone orchestrator takes any org id an
 * operator passes to `kici-admin source add generic --org` (stored in the 255-wide
 * `generic_webhook_sources.customer_id`), and the generic webhook route resolves deliveries
 * against it. These columns hold that same id, so they share its width: a narrower column
 * refuses the write, which drops a delivery's `event_log` row and fails a context or scoped
 * secret for that org.
 *
 * PostgreSQL widens a `varchar` limit in place: no table rewrite and no index rebuild, so the
 * statement holds its lock for a catalog update only, whatever the row count. Re-running it on
 * a widened column is a no-op.
 */

const ORG_ID_TABLES = [
  'access_log',
  'context_bindings',
  'context_source_overrides',
  'context_variables',
  'contexts',
  'event_log',
  'held_runs',
  'scoped_secrets',
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of ORG_ID_TABLES) {
    await sql.raw(`ALTER TABLE public.${table} ALTER COLUMN org_id TYPE varchar(255)`).execute(db);
  }
}

/** Fails when a row holds an org id longer than 16 characters, rather than truncating it. */
export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ORG_ID_TABLES) {
    await sql.raw(`ALTER TABLE public.${table} ALTER COLUMN org_id TYPE varchar(16)`).execute(db);
  }
}
