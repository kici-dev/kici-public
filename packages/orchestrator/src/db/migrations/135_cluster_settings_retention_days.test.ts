import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './135_cluster_settings_retention_days.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 135: asserts the four retention-window
 * columns and the announce stamp exist on `cluster_settings` as nullable
 * columns after migrations 001..135, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig135_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 135_cluster_settings_retention_days', () => {
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
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  const NUMERIC_COLUMNS = [
    'run_retention_days',
    'audit_retention_days',
    'provenance_retention_days',
    'held_run_retention_days',
  ];

  it('adds every retention window as a nullable integer column', async () => {
    for (const col of NUMERIC_COLUMNS) {
      const state = await columnState(col);
      expect(state.exists, col).toBe(true);
      expect(state.nullable, col).toBe(true);
      expect(state.dataType, col).toBe('integer');
    }
  });

  it('adds retention_announced_at as a nullable timestamptz', async () => {
    const state = await columnState('retention_announced_at');
    expect(state.exists).toBe(true);
    expect(state.nullable).toBe(true);
    expect(state.dataType).toBe('timestamp with time zone');
  });

  it('round-trips stored windows', async () => {
    await sql`
      INSERT INTO public.cluster_settings
        (id, run_retention_days, audit_retention_days, provenance_retention_days,
         held_run_retention_days)
      VALUES ('default', 120, 400, 400, 45)
      ON CONFLICT (id) DO UPDATE
        SET run_retention_days = EXCLUDED.run_retention_days,
            audit_retention_days = EXCLUDED.audit_retention_days,
            provenance_retention_days = EXCLUDED.provenance_retention_days,
            held_run_retention_days = EXCLUDED.held_run_retention_days
    `.execute(db);
    const r = await sql<Record<string, string | number | null>>`
      SELECT run_retention_days, audit_retention_days, provenance_retention_days,
             held_run_retention_days
        FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(Number(r.rows[0]?.run_retention_days)).toBe(120);
    expect(Number(r.rows[0]?.audit_retention_days)).toBe(400);
    expect(Number(r.rows[0]?.provenance_retention_days)).toBe(400);
    expect(Number(r.rows[0]?.held_run_retention_days)).toBe(45);
  });

  it('accepts 0, the documented value that disables a window', async () => {
    await sql`
      INSERT INTO public.cluster_settings (id, run_retention_days)
      VALUES ('default', 0)
      ON CONFLICT (id) DO UPDATE SET run_retention_days = EXCLUDED.run_retention_days
    `.execute(db);
    const r = await sql<{ run_retention_days: string | number | null }>`
      SELECT run_retention_days FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(Number(r.rows[0]?.run_retention_days)).toBe(0);
  });

  it('stamps and reads back retention_announced_at', async () => {
    await sql`
      INSERT INTO public.cluster_settings (id, retention_announced_at)
      VALUES ('default', now())
      ON CONFLICT (id) DO UPDATE SET retention_announced_at = EXCLUDED.retention_announced_at
    `.execute(db);
    const r = await sql<{ retention_announced_at: Date | null }>`
      SELECT retention_announced_at FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(r.rows[0]?.retention_announced_at).toBeInstanceOf(Date);
  });

  it('down() drops every column and up() restores them', async () => {
    await down(db);
    for (const col of [...NUMERIC_COLUMNS, 'retention_announced_at']) {
      expect((await columnState(col)).exists, col).toBe(false);
    }
    await up(db);
    await up(db); // idempotent
    for (const col of [...NUMERIC_COLUMNS, 'retention_announced_at']) {
      expect((await columnState(col)).exists, col).toBe(true);
    }
  });
});
