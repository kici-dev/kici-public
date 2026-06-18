import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import * as m030 from './030_held_runs_env_set_null.js';

/**
 * Real-Postgres test for migration 030.
 *
 * Creates a uniquely-named throwaway database inside the admin Postgres
 * server, runs every migration up to 030 via the production migration
 * provider, and asserts that held_runs.environment_id is nullable with an
 * ON DELETE SET NULL foreign key. The throwaway database is dropped in
 * teardown, so the test never mutates any shared schema or data.
 *
 * The admin connection string comes solely from
 * `KICI_TEST_ADMIN_DATABASE_URL`. The suite is gated on the presence of that
 * env var: when it is unset the suite skips, so it stays runnable in
 * environments without a database. When it is set but the server is
 * unreachable, the test fails loudly rather than skipping green.
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

  // describeDb only runs when KICI_TEST_ADMIN_DATABASE_URL is set, so the
  // non-null assertion is safe inside the suite body.
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

    // Apply every migration (001..030) via the production provider so the
    // held_runs table the constraint attaches to actually exists.
    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});

    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      // Terminate any lingering backends before dropping.
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
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

    // Re-apply so the schema is restored to the migrated state.
    await m030.up(db);
    expect(await columnIsNullable()).toBe('YES');
    expect(await fkDeleteAction()).toBe('n');
  });
});
