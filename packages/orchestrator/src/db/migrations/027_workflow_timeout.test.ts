import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import * as m027 from './027_workflow_timeout.js';
import { terminateTestDbBackends } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for migration 027: applies 001..027 into a throwaway database (dropped in
 * teardown, so no shared schema is touched) and asserts the schema via information_schema.
 * Skips when `KICI_TEST_ADMIN_DATABASE_URL` is unset; fails loudly when set but unreachable.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;

const describeDb = ADMIN_URL ? describe : describe.skip;

const TEST_DB = `kici_mig027_test_${process.pid}_${Date.now()}`;

/** Replace the database name in a connection URL. */
function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 027_workflow_timeout', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;

  const columnInfo = async (): Promise<{ data_type: string; is_nullable: string } | undefined> => {
    const result = await sql<{ data_type: string; is_nullable: string }>`
      SELECT data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = 'workflow_timeout_ms'
    `.execute(db);
    return result.rows[0];
  };

  const colExists = async (): Promise<boolean> => {
    const info = await columnInfo();
    return info !== undefined;
  };

  // Safe: describeDb only runs when KICI_TEST_ADMIN_DATABASE_URL is set.
  const adminUrl = ADMIN_URL!;

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

  it('adds a nullable integer workflow_timeout_ms column to execution_runs', async () => {
    const info = await columnInfo();
    expect(info?.data_type).toBe('integer');
    expect(info?.is_nullable).toBe('YES');
  });

  it('up() is idempotent (re-running is a no-op)', async () => {
    await m027.up(db);
    await m027.up(db);
    expect(await colExists()).toBe(true);
  });

  it('down() drops the column', async () => {
    await m027.down(db);
    expect(await colExists()).toBe(false);

    // down() must also be idempotent, and up() must restore the schema.
    await m027.down(db);
    await m027.up(db);
    expect(await colExists()).toBe(true);
  });
});
