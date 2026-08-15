import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './094_dashboard_encryption_keys.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig094_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 094_dashboard_encryption_keys', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const tableExists = async (): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'dashboard_encryption_keys'
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  const indexExists = async (): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE tablename = 'dashboard_encryption_keys'
           AND indexname = 'idx_dashboard_encryption_keys_status'
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

  it('applies migrations 001..094 and creates the table + status index', async () => {
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    expect(error).toBeUndefined();
    expect(await tableExists()).toBe(true);
    expect(await indexExists()).toBe(true);
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'dashboard_encryption_keys'
    `.execute(db);
    const names = cols.rows.map((c) => c.column_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'kid',
        'public_jwk',
        'encrypted_private_key',
        'status',
        'revocation_reason',
        'created_at',
        'activated_at',
        'revoked_at',
      ]),
    );
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
