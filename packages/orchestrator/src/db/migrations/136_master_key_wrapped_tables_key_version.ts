import { type Kysely, sql } from 'kysely';

/**
 * `key_version` on the master-key-wrapped tables that lacked it (`orchestrator_signing_keys`
 * already has one); mirrors `secret_backends.config_key_version`. The self-heal re-seal guards
 * its UPDATE on the version it read (`WHERE key_version = <read>`), so a boot-time re-seal from
 * a stale snapshot cannot clobber a concurrent rotation.
 *
 * `NOT NULL DEFAULT 1`: every existing row was sealed at version 1 (hardcoded `keyVersion: 1`
 * at each write site), so 1 is the true backfill value, not "unknown".
 *
 * Idempotent.
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
