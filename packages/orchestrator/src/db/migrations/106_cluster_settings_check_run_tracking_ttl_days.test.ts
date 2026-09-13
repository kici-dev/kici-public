import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './106_cluster_settings_check_run_tracking_ttl_days.js';

/**
 * Real-Postgres test for migration 106: asserts
 * `cluster_settings.check_run_tracking_ttl_days` exists as a nullable integer
 * column after migrations 001..106, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig106_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 106_cluster_settings_check_run_tracking_ttl_days', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
    col: string,
  ): Promise<{ exists: boolean; nullable: boolean; dataType: string }> => {
    const r = await sql<{ is_nullable: string; data_type: string }>`
      SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'cluster_settings'
         AND column_name = ${col}
    `.execute(db);
    const row = r.rows[0];
    return {
      exists: row !== undefined,
      nullable: row?.is_nullable === 'YES',
      dataType: row?.data_type ?? '',
    };
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

  it('adds a nullable integer check_run_tracking_ttl_days column', async () => {
    const state = await columnState('check_run_tracking_ttl_days');
    expect(state.exists).toBe(true);
    expect(state.nullable).toBe(true);
    expect(state.dataType).toBe('integer');
  });

  it('round-trips a stored check_run_tracking_ttl_days', async () => {
    await sql`
      INSERT INTO public.cluster_settings (id, check_run_tracking_ttl_days)
      VALUES ('default', 14)
      ON CONFLICT (id) DO UPDATE
        SET check_run_tracking_ttl_days = EXCLUDED.check_run_tracking_ttl_days
    `.execute(db);
    const r = await sql<{ check_run_tracking_ttl_days: string | number | null }>`
      SELECT check_run_tracking_ttl_days FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(Number(r.rows[0]?.check_run_tracking_ttl_days)).toBe(14);
  });

  it('accepts 0, the documented value that disables the sweep', async () => {
    await sql`
      INSERT INTO public.cluster_settings (id, check_run_tracking_ttl_days)
      VALUES ('default', 0)
      ON CONFLICT (id) DO UPDATE
        SET check_run_tracking_ttl_days = EXCLUDED.check_run_tracking_ttl_days
    `.execute(db);
    const r = await sql<{ check_run_tracking_ttl_days: string | number | null }>`
      SELECT check_run_tracking_ttl_days FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(Number(r.rows[0]?.check_run_tracking_ttl_days)).toBe(0);
  });

  it('down() drops the column and up() restores it', async () => {
    await down(db);
    expect((await columnState('check_run_tracking_ttl_days')).exists).toBe(false);
    await up(db);
    await up(db); // idempotent
    expect((await columnState('check_run_tracking_ttl_days')).exists).toBe(true);
  });
});
