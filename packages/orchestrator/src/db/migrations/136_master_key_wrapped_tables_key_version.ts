import { type Kysely, sql } from 'kysely';

/**
 * Add `key_version INTEGER NOT NULL DEFAULT 1` to the three master-key-wrapped
 * tables that lacked it: `dashboard_encryption_keys`, `run_ephemeral_keys` and
 * `run_secret_outputs`. (`orchestrator_signing_keys` already carries one.)
 *
 * The column mirrors `secret_backends.config_key_version`. It is what makes a
 * rotation sweep of these tables safe: the self-heal that re-seals a row found
 * under the old key guards its UPDATE on the version it read
 * (`WHERE key_version = <read>`), so a rotation running concurrently cannot be
 * clobbered by a boot-time re-seal that started from a stale snapshot. Without
 * a version column that guard cannot be written at all.
 *
 * `NOT NULL DEFAULT 1` rather than nullable: every existing row was sealed at
 * version 1 by the hardcoded `keyVersion: 1` at each write site, so 1 is the
 * true value for the whole backfill — not a stand-in for "unknown".
 *
 * Idempotent: each add is guarded on existence and each drop uses IF EXISTS, so
 * a re-run is a no-op.
 */
const TABLES = ['dashboard_encryption_keys', 'run_ephemeral_keys', 'run_secret_outputs'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    const check = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = ${table}
           AND column_name = 'key_version'
      ) AS exists
    `.execute(db);
    if (check.rows[0]?.exists === true) continue;

    await sql`
      ALTER TABLE public.${sql.raw(table)}
        ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await sql`
      ALTER TABLE public.${sql.raw(table)} DROP COLUMN IF EXISTS key_version
    `.execute(db);
  }
}
