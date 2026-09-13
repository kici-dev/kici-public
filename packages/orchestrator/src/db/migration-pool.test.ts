import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPool } from './client.js';
import { createMigrationPool } from './migrator.js';

// Real-Postgres proof that schema work escapes the hot path's statement
// timeout. The mocked coverage in migrator.test.ts asserts the pool is
// *configured* with `statement_timeout: 0`; only a live server proves the
// setting actually reaches the connections a migration runs on. Gated on
// KICI_TEST_ADMIN_DATABASE_URL.
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_migration_pool_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration pool statement timeout (real Postgres)', () => {
  const adminUrl = ADMIN_URL!;
  let url: string;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    url = withDatabase(adminUrl, TEST_DB);
  }, 60_000);

  afterAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('cancels a long statement on a hot-path pool', async () => {
    const hot = createPool(url, { config: { max: 1, statement_timeout: 1000 } });
    try {
      await expect(hot.query('SELECT pg_sleep(3)')).rejects.toThrow(/statement timeout/i);
    } finally {
      await hot.end();
    }
  }, 30_000);

  it('lets the same statement finish on the migration pool', async () => {
    const migration = createMigrationPool(url);
    try {
      const setting = await migration.query<{ statement_timeout: string }>(
        'SHOW statement_timeout',
      );
      expect(setting.rows[0]?.statement_timeout).toBe('0');

      const res = await migration.query('SELECT pg_sleep(3)');
      expect(res.rowCount).toBe(1);
    } finally {
      await migration.end();
    }
  }, 30_000);
});
