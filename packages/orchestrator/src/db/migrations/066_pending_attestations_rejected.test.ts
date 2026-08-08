import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './066_pending_attestations_rejected.js';

/**
 * Real-Postgres test for migration 066. Creates a throwaway database, applies
 * migrations 001..066, and asserts the pending_attestations.rejected_at column
 * exists and is nullable; down() drops it and up() is idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig066_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 066_pending_attestations_rejected', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnInfo = async (): Promise<{ is_nullable: string } | undefined> => {
    const result = await sql<{ is_nullable: string }>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pending_attestations'
         AND column_name = 'rejected_at'
    `.execute(db);
    return result.rows[0];
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

  it('adds a nullable rejected_at column (the beforeAll migration ran it)', async () => {
    const info = await columnInfo();
    expect(info).toBeDefined();
    expect(info!.is_nullable).toBe('YES');
  });

  it('down() drops rejected_at; up() recreates idempotently', async () => {
    await down(db);
    expect(await columnInfo()).toBeUndefined();
    await up(db);
    await up(db); // idempotent (existence guard)
    const info = await columnInfo();
    expect(info).toBeDefined();
    expect(info!.is_nullable).toBe('YES');
  });
});
