import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import * as m152 from './152_org_settings_cache_upload_settle_timeout.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 152. Applies migrations up to 152 in a
 * throwaway database and asserts the nullable, default-less
 * `cache_upload_settle_timeout_ms` column (NULL = cluster default). Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig152_test_${process.pid}_${Date.now()}`;
const COLUMN = 'cache_upload_settle_timeout_ms';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 152_org_settings_cache_upload_settle_timeout', () => {
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
         AND table_name = 'org_settings'
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
    // default would override the cluster value for every org).
    expect(await columnMeta()).toEqual({ nullable: 'YES', defaultValue: null });
  });

  it('up() is idempotent', async () => {
    await m152.up(db);
    await m152.up(db);
    expect(await columnMeta()).not.toBeNull();
  });

  it('down() drops the column and up() restores it', async () => {
    await m152.down(db);
    expect(await columnMeta()).toBeNull();
    await m152.down(db);
    await m152.up(db);
    expect(await columnMeta()).not.toBeNull();
  });
});
