import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './044_check_mode.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig044_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 044_check_mode', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnType = async (
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
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
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

  it('adds nullable check-mode columns to execution_runs and execution_steps', async () => {
    const checkMode = await columnType('execution_runs', 'check_mode');
    expect(checkMode?.data_type).toBe('text');
    expect(checkMode?.is_nullable).toBe('YES');

    const checkOutcome = await columnType('execution_steps', 'check_outcome');
    expect(checkOutcome?.data_type).toBe('text');
    expect(checkOutcome?.is_nullable).toBe('YES');

    const driftSummary = await columnType('execution_steps', 'drift_summary');
    expect(driftSummary?.data_type).toBe('text');
    expect(driftSummary?.is_nullable).toBe('YES');

    const drift = await columnType('execution_steps', 'drift');
    expect(drift?.data_type).toBe('jsonb');
    expect(drift?.is_nullable).toBe('YES');
  });

  it('down() drops and up() re-adds the columns idempotently', async () => {
    await down(db);
    expect(await columnType('execution_runs', 'check_mode')).toBeNull();
    expect(await columnType('execution_steps', 'check_outcome')).toBeNull();
    await up(db);
    await up(db);
    expect(await columnType('execution_runs', 'check_mode')).not.toBeNull();
    expect(await columnType('execution_steps', 'drift')).not.toBeNull();
  });
});
