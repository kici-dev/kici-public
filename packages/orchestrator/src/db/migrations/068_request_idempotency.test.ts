import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './068_request_idempotency.js';

/**
 * Real-Postgres test for migration 068. Creates a throwaway database, applies
 * migrations 001..068, and asserts the request_idempotency table + primary key +
 * created_at index exist; down() drops it and up() is idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig068_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 068_request_idempotency', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const tableExists = async (): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'request_idempotency'
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  const primaryKeyColumn = async (): Promise<string | undefined> => {
    const result = await sql<{ column_name: string }>`
      SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.table_schema = 'public'
         AND tc.table_name = 'request_idempotency'
         AND tc.constraint_type = 'PRIMARY KEY'
    `.execute(db);
    return result.rows[0]?.column_name;
  };

  const indexExists = async (): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'idx_request_idempotency_created_at'
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
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

  it('creates request_idempotency with request_id PK + created_at index (the beforeAll migration ran it)', async () => {
    expect(await tableExists()).toBe(true);
    expect(await primaryKeyColumn()).toBe('request_id');
    expect(await indexExists()).toBe(true);
  });

  it('down() drops the table; up() recreates idempotently', async () => {
    await down(db);
    expect(await tableExists()).toBe(false);
    await up(db);
    await up(db); // idempotent (existence guard)
    expect(await tableExists()).toBe(true);
    expect(await primaryKeyColumn()).toBe('request_id');
    expect(await indexExists()).toBe(true);
  });
});
