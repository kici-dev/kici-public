import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './086_cluster_settings_max_fanout_hosts.js';

/**
 * Real-Postgres test for migration 086: asserts `cluster_settings.max_fanout_hosts`
 * exists and is nullable after migrations 001..086, and that up/down are
 * idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig086_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 086_cluster_settings_max_fanout_hosts', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (col: string): Promise<{ exists: boolean; nullable: boolean }> => {
    const r = await sql<{ is_nullable: string }>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = ${col}
    `.execute(db);
    const row = r.rows[0];
    return { exists: row !== undefined, nullable: row?.is_nullable === 'YES' };
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
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('adds a nullable max_fanout_hosts column', async () => {
    const state = await columnState('max_fanout_hosts');
    expect(state.exists).toBe(true);
    expect(state.nullable).toBe(true);
  });

  it('down() drops the column and up() restores it', async () => {
    await down(db);
    expect((await columnState('max_fanout_hosts')).exists).toBe(false);
    await up(db);
    await up(db); // idempotent
    expect((await columnState('max_fanout_hosts')).exists).toBe(true);
  });
});
