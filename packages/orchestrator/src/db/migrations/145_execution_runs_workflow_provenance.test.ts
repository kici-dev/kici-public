import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './145_execution_runs_workflow_provenance.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 145: asserts `execution_runs.workflow_sha`
 * and `execution_runs.workflow_branch` exist as nullable text columns after
 * migrations 001..145, that `up` is idempotent on an upgraded database, and
 * that `down` removes both. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig145_test_${process.pid}_${Date.now()}`;

const COLUMNS = ['workflow_branch', 'workflow_sha'];

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 145_execution_runs_workflow_provenance', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columns = async (): Promise<
    { column_name: string; data_type: string; is_nullable: string }[]
  > => {
    const r = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name IN ('workflow_sha', 'workflow_branch')
       ORDER BY column_name
    `.execute(db);
    return r.rows;
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    await adminPool.end();
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

  it('adds workflow_sha and workflow_branch as nullable text', async () => {
    // fails-when: up() adds neither column, or adds one as NOT NULL
    const rows = await columns();
    expect(rows.map((r) => r.column_name)).toEqual(COLUMNS);
    for (const row of rows) {
      expect(row.data_type).toBe('text');
      expect(row.is_nullable).toBe('YES');
    }
  });

  it('re-running up() is a no-op, and down() removes both columns', async () => {
    // breaks-if-wrong: re-running up on an already-upgraded database must not throw
    await up(db);
    expect((await columns()).map((r) => r.column_name)).toEqual(COLUMNS);

    // fails-when: down() leaves either column behind
    await down(db);
    expect(await columns()).toEqual([]);

    await up(db);
    expect((await columns()).map((r) => r.column_name)).toEqual(COLUMNS);
  });
});
