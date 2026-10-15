import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import * as m030 from './030_held_runs_env_set_null.js';
import { terminateTestDbBackends } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for migration 030: applies 001..030 via the production
 * provider in a uniquely-named throwaway database (dropped in teardown) and
 * asserts held_runs.environment_id is nullable with an ON DELETE SET NULL FK.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`: unset skips; set but unreachable
 * fails loudly rather than skipping green.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;

const describeDb = ADMIN_URL ? describe : describe.skip;

const TEST_DB = `kici_mig030_test_${process.pid}_${Date.now()}`;

/** Replace the database name in a connection URL. */
function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 030_held_runs_env_set_null', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;

  const columnIsNullable = async (): Promise<string | undefined> => {
    const result = await sql<{ is_nullable: string }>`
      SELECT is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'held_runs'
         AND column_name = 'environment_id'
    `.execute(db);
    return result.rows[0]?.is_nullable;
  };

  const fkDeleteAction = async (): Promise<string | undefined> => {
    const result = await sql<{ confdeltype: string }>`
      SELECT confdeltype
        FROM pg_constraint
       WHERE conname = 'held_runs_environment_id_fkey'
         AND conrelid = 'public.held_runs'::regclass
    `.execute(db);
    return result.rows[0]?.confdeltype;
  };

  // describeDb only runs when KICI_TEST_ADMIN_DATABASE_URL is set.
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

    // Apply 001..030 so the held_runs table the constraint attaches to exists.
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

  it('makes environment_id nullable', async () => {
    expect(await columnIsNullable()).toBe('YES');
  });

  it('sets the foreign key ON DELETE action to SET NULL', async () => {
    // pg_constraint.confdeltype: 'n' = SET NULL, 'a' = NO ACTION, 'c' = CASCADE.
    expect(await fkDeleteAction()).toBe('n');
  });

  it('up() is idempotent (re-running is a no-op)', async () => {
    await m030.up(db);
    await m030.up(db);
    expect(await columnIsNullable()).toBe('YES');
    expect(await fkDeleteAction()).toBe('n');
  });

  it('down() restores NOT NULL and the NO ACTION foreign key', async () => {
    await m030.down(db);
    expect(await columnIsNullable()).toBe('NO');
    expect(await fkDeleteAction()).toBe('a');

    await m030.up(db);
    expect(await columnIsNullable()).toBe('YES');
    expect(await fkDeleteAction()).toBe('n');
  });
});
