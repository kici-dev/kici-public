import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import * as m025 from './025_init_failure.js';
import { terminateTestDbBackends } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for migration 025: applies 001..025 to a throwaway database dropped in
 * teardown. Skips without `KICI_TEST_ADMIN_DATABASE_URL`; fails loudly when it is set but the
 * server is unreachable.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;

const describeDb = ADMIN_URL ? describe : describe.skip;

const TEST_DB = `kici_mig025_test_${process.pid}_${Date.now()}`;

/** Replace the database name in a connection URL. */
function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 025_init_failure', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;

  const columnInfo = async (
    table: string,
  ): Promise<{ data_type: string; is_nullable: string } | undefined> => {
    const result = await sql<{ data_type: string; is_nullable: string }>`
      SELECT data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = 'init_failure'
    `.execute(db);
    return result.rows[0];
  };

  const colExists = async (table: string): Promise<boolean> => {
    const info = await columnInfo(table);
    return info !== undefined;
  };

  // Safe: describeDb runs only when KICI_TEST_ADMIN_DATABASE_URL is set.
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

  it('adds nullable init_failure jsonb columns to execution_runs and execution_jobs', async () => {
    for (const table of ['execution_runs', 'execution_jobs']) {
      const info = await columnInfo(table);
      expect(info?.data_type).toBe('jsonb');
      expect(info?.is_nullable).toBe('YES');
    }
  });

  it('up() is idempotent (re-running is a no-op)', async () => {
    await m025.up(db);
    await m025.up(db);
    expect(await colExists('execution_runs')).toBe(true);
    expect(await colExists('execution_jobs')).toBe(true);
  });

  it('down() drops the columns', async () => {
    await m025.down(db);
    expect(await colExists('execution_runs')).toBe(false);
    expect(await colExists('execution_jobs')).toBe(false);

    // down() must also be idempotent, and up() must restore the schema.
    await m025.down(db);
    await m025.up(db);
    expect(await colExists('execution_runs')).toBe(true);
    expect(await colExists('execution_jobs')).toBe(true);
  });
});
