import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './069_reroute_tunables.js';

/**
 * Real-Postgres test for migration 069. Creates a throwaway database, applies
 * migrations 001..069, and asserts the three reroute-tunable columns exist on
 * org_settings, are nullable; down() drops them and up() is idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig069_test_${process.pid}_${Date.now()}`;

const COLUMNS = ['reroute_spawn_window_ms', 'reroute_ack_timeout_ms', 'reroute_max_hops'] as const;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 069_reroute_tunables', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnMeta = async (column: string): Promise<{ exists: boolean; nullable: boolean }> => {
    const result = await sql<{ is_nullable: string }>`
      SELECT is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = ${column}
    `.execute(db);
    const row = result.rows[0];
    return { exists: Boolean(row), nullable: row?.is_nullable === 'YES' };
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
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

  it('creates the three nullable reroute-tunable columns (the beforeAll migration ran it)', async () => {
    for (const column of COLUMNS) {
      const meta = await columnMeta(column);
      expect(meta.exists, `${column} exists`).toBe(true);
      expect(meta.nullable, `${column} nullable`).toBe(true);
    }
  });

  it('down() drops the columns; up() recreates idempotently', async () => {
    await down(db);
    for (const column of COLUMNS) {
      expect((await columnMeta(column)).exists, `${column} dropped`).toBe(false);
    }
    await up(db);
    await up(db); // idempotent (column-exists guard)
    for (const column of COLUMNS) {
      expect((await columnMeta(column)).exists, `${column} recreated`).toBe(true);
    }
  });
});
