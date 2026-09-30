import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import * as m153 from './153_execution_runs_cancel_force.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 153. Applies migrations up to 153 in a
 * throwaway database and asserts the nullable, default-less `cancel_force`
 * column (NULL = a graceful re-drive). Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig153_test_${process.pid}_${Date.now()}`;
const COLUMN = 'cancel_force';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 153_execution_runs_cancel_force', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnMeta = async (): Promise<{
    nullable: string;
    defaultValue: string | null;
  } | null> => {
    const result = await sql<{ is_nullable: string; column_default: string | null }>`
      SELECT is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = ${COLUMN}
    `.execute(db);
    const row = result.rows[0];
    return row ? { nullable: row.is_nullable, defaultValue: row.column_default } : null;
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
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('adds a nullable column with no default', async () => {
    // fails-when: the column is missing, NOT NULL, or carries a DEFAULT (a
    // TRUE default would re-send every stuck cancel forced).
    expect(await columnMeta()).toEqual({ nullable: 'YES', defaultValue: null });
  });

  it('up() is idempotent', async () => {
    await m153.up(db);
    await m153.up(db);
    expect(await columnMeta()).not.toBeNull();
  });

  it('down() drops the column and up() restores it', async () => {
    await m153.down(db);
    expect(await columnMeta()).toBeNull();
    await m153.down(db);
    await m153.up(db);
    expect(await columnMeta()).not.toBeNull();
  });
});
