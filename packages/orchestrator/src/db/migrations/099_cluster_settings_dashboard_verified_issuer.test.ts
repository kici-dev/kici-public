import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './099_cluster_settings_dashboard_verified_issuer.js';

/**
 * Real-Postgres test for migration 099: asserts
 * `cluster_settings.dashboard_verified_issuer` exists as a nullable text column
 * after migrations 001..099, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig099_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 099_cluster_settings_dashboard_verified_issuer', () => {
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

  it('adds a nullable text dashboard_verified_issuer column', async () => {
    const state = await columnState('dashboard_verified_issuer');
    expect(state.exists).toBe(true);
    expect(state.nullable).toBe(true);
    expect(state.dataType).toBe('text');
  });

  it('round-trips a stored issuer origin', async () => {
    await sql`
      INSERT INTO public.cluster_settings (id, dashboard_verified_issuer)
      VALUES ('default', 'https://orch.example.com')
      ON CONFLICT (id) DO UPDATE SET dashboard_verified_issuer = EXCLUDED.dashboard_verified_issuer
    `.execute(db);
    const r = await sql<{ dashboard_verified_issuer: string | null }>`
      SELECT dashboard_verified_issuer FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(r.rows[0]?.dashboard_verified_issuer).toBe('https://orch.example.com');
  });

  it('down() drops the column and up() restores it', async () => {
    await down(db);
    expect((await columnState('dashboard_verified_issuer')).exists).toBe(false);
    await up(db);
    await up(db); // idempotent
    expect((await columnState('dashboard_verified_issuer')).exists).toBe(true);
  });
});
