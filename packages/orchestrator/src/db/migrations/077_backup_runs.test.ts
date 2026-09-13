import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './077_backup_runs.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig077_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 077_backup_runs', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const tableExists = async (): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'backup_runs'
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    await adminPool.end();
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await adminPool.end();
  });

  it('applies migrations 001..077 and creates backup_runs', async () => {
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    expect(error).toBeUndefined();
    expect(await tableExists()).toBe(true);
  });

  it('up() is idempotent and down() drops the table', async () => {
    await up(db);
    expect(await tableExists()).toBe(true);
    await down(db);
    expect(await tableExists()).toBe(false);
    await up(db);
    expect(await tableExists()).toBe(true);
  });
});
