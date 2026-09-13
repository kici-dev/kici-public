import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './136_master_key_wrapped_tables_key_version.js';

/**
 * Real-Postgres test for migration 136: asserts `key_version` exists on all
 * three master-key-wrapped tables that lacked it, as a NOT NULL integer
 * defaulting to 1, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * The default is the load-bearing part: every pre-existing row was sealed at
 * version 1 by the hardcoded `keyVersion: 1` at each write site, so a row that
 * predates the column must read back as 1 — not NULL — for the rotation sweep's
 * concurrent-write guard to compare against anything.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig136_test_${process.pid}_${Date.now()}`;

const TABLES = ['dashboard_encryption_keys', 'run_ephemeral_keys', 'run_secret_outputs'];

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 136_master_key_wrapped_tables_key_version', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
    table: string,
  ): Promise<{
    exists: boolean;
    nullable: boolean;
    dataType: string;
    columnDefault: string | null;
  }> => {
    const r = await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
      SELECT is_nullable, data_type, column_default FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = 'key_version'
    `.execute(db);
    const row = r.rows[0];
    return {
      exists: row !== undefined,
      nullable: row?.is_nullable === 'YES',
      dataType: row?.data_type ?? '',
      columnDefault: row?.column_default ?? null,
    };
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    await adminPool.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it.each(TABLES)('adds a NOT NULL integer defaulting to 1 on %s', async (table) => {
    const state = await columnState(table);
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('integer');
    expect(state.nullable).toBe(false);
    expect(state.columnDefault).toBe('1');
  });

  it('defaults an inserted row to version 1 without naming the column', async () => {
    await sql`
      INSERT INTO public.run_ephemeral_keys (run_id, encrypted_private_key, public_key)
      VALUES ('mig136-run', 'wrapped', 'pub')
    `.execute(db);
    const r = await sql<{ key_version: number }>`
      SELECT key_version FROM public.run_ephemeral_keys WHERE run_id = 'mig136-run'
    `.execute(db);
    expect(r.rows[0]?.key_version).toBe(1);
  });

  it('down() drops every column and up() restores them, idempotently', async () => {
    await down(db);
    for (const table of TABLES) expect((await columnState(table)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    for (const table of TABLES) expect((await columnState(table)).exists).toBe(true);
  });
});
