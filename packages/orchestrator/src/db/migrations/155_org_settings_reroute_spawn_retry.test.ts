import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import * as m155 from './155_org_settings_reroute_spawn_retry.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 155. Applies migrations up to 155 in a
 * throwaway database and asserts the two nullable, default-less spawn-retry
 * columns (NULL = cluster default). Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig155_test_${process.pid}_${Date.now()}`;
const COLUMNS = {
  reroute_spawn_max_attempts: 'integer',
  reroute_spawn_retry_backoff_ms: 'bigint',
} as const;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 155_org_settings_reroute_spawn_retry', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnMeta = async (
    column: string,
  ): Promise<{ type: string; nullable: string; defaultValue: string | null } | null> => {
    const result = await sql<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>`
      SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'org_settings'
         AND column_name = ${column}
    `.execute(db);
    const row = result.rows[0];
    return row
      ? { type: row.data_type, nullable: row.is_nullable, defaultValue: row.column_default }
      : null;
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

  it('adds both columns nullable, typed, with no default', async () => {
    // fails-when: a column is missing, NOT NULL, mistyped, or carries a DEFAULT (a
    // default would override the cluster value for every org).
    for (const [column, type] of Object.entries(COLUMNS)) {
      expect(await columnMeta(column)).toEqual({ type, nullable: 'YES', defaultValue: null });
    }
  });

  it('up() is idempotent', async () => {
    await m155.up(db);
    await m155.up(db);
    for (const column of Object.keys(COLUMNS)) {
      expect(await columnMeta(column)).not.toBeNull();
    }
  });

  it('down() drops both columns and up() restores them', async () => {
    await m155.down(db);
    for (const column of Object.keys(COLUMNS)) {
      expect(await columnMeta(column)).toBeNull();
    }
    await m155.down(db);
    await m155.up(db);
    for (const column of Object.keys(COLUMNS)) {
      expect(await columnMeta(column)).not.toBeNull();
    }
  });
});
