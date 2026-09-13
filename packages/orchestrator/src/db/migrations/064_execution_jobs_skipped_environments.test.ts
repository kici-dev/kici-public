import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { up } from './064_execution_jobs_skipped_environments.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig064_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 064_execution_jobs_skipped_environments', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const column = async (
    table: string,
    name: string,
  ): Promise<{ data_type: string; is_nullable: string } | null> => {
    const r = await sql<{ data_type: string; is_nullable: string }>`
      SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name=${table} AND column_name=${name}`.execute(db);
    return r.rows[0] ?? null;
  };

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [TEST_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('adds nullable text columns skipped_environments and env_warning', async () => {
    const skipped = await column('execution_jobs', 'skipped_environments');
    expect(skipped?.data_type).toBe('text');
    expect(skipped?.is_nullable).toBe('YES');
    const warning = await column('execution_jobs', 'env_warning');
    expect(warning?.data_type).toBe('text');
    expect(warning?.is_nullable).toBe('YES');
  });

  it('is idempotent (re-running up() over an already-migrated table is a no-op)', async () => {
    // the beforeAll migration already applied up() once; a second run must not throw.
    await up(db);
    const skipped = await column('execution_jobs', 'skipped_environments');
    expect(skipped?.data_type).toBe('text');
  });
});
