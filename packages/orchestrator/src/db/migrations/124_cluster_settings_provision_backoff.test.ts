import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './124_cluster_settings_provision_backoff.js';

/**
 * Real-Postgres test for migration 124: asserts the three external-provision
 * backoff columns exist on `cluster_settings` as nullable BIGINTs after
 * migrations 001..124, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig124_test_${process.pid}_${Date.now()}`;

const BACKOFF_COLUMNS = [
  'scaler_provision_backoff_base_ms',
  'scaler_provision_backoff_max_ms',
  'scaler_provision_max_consecutive_failures',
] as const;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 124_cluster_settings_provision_backoff', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
    table: string,
    col: string,
  ): Promise<{ exists: boolean; nullable: boolean; dataType: string }> => {
    const r = await sql<{ is_nullable: string; data_type: string }>`
      SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
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

  it('adds all three nullable bigint backoff columns', async () => {
    for (const column of BACKOFF_COLUMNS) {
      const state = await columnState('cluster_settings', column);
      expect(state.exists, `${column} should exist`).toBe(true);
      // Nullable with no DEFAULT: NULL is the "operator never set this" signal
      // the reader turns into the configured default.
      expect(state.nullable, `${column} should be nullable`).toBe(true);
      // BIGINT, not INTEGER: a ceiling an operator widens to a day leaves
      // INTEGER range.
      expect(state.dataType, `${column} should be bigint`).toBe('bigint');
    }
  });

  it('round-trips a value larger than INTEGER range', async () => {
    await sql`
      INSERT INTO public.cluster_settings (id, scaler_provision_backoff_max_ms)
      VALUES ('default', 8589934592)
      ON CONFLICT (id) DO UPDATE
        SET scaler_provision_backoff_max_ms = EXCLUDED.scaler_provision_backoff_max_ms
    `.execute(db);
    const r = await sql<{ scaler_provision_backoff_max_ms: string | number | null }>`
      SELECT scaler_provision_backoff_max_ms FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(Number(r.rows[0]?.scaler_provision_backoff_max_ms)).toBe(8_589_934_592);
  });

  it('down() drops all three and up() restores them', async () => {
    await down(db);
    for (const column of BACKOFF_COLUMNS) {
      expect((await columnState('cluster_settings', column)).exists, column).toBe(false);
    }

    await up(db);
    await up(db); // idempotent
    for (const column of BACKOFF_COLUMNS) {
      expect((await columnState('cluster_settings', column)).exists, column).toBe(true);
    }
  });
});
