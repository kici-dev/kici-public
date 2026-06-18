import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import * as m027 from './027_workflow_timeout.js';

/**
 * Real-Postgres test for migration 027.
 *
 * Creates a uniquely-named throwaway database inside the admin Postgres
 * server, runs every migration up to 027 via the production migration
 * provider, and asserts the resulting schema with information_schema. The
 * throwaway database is dropped in teardown, so the test never mutates any
 * shared schema or data.
 *
 * The admin connection string comes solely from
 * `KICI_TEST_ADMIN_DATABASE_URL`. The suite is gated on the presence of that
 * env var: when it is unset the suite skips, so it stays runnable in
 * environments without a database. When it is set but the server is
 * unreachable, the test fails loudly rather than skipping green.
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

    // Apply every migration (001..027) via the production provider so the
    // execution_runs table the column attaches to exists.
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
