import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './104_check_run_terminal_sent.js';

/**
 * Real-Postgres test for migration 104: asserts
 * `check_run_tracking.terminal_sent_at` exists as a nullable timestamptz column
 * after migrations 001..104, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig104_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 104_check_run_terminal_sent', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
    col: string,
  ): Promise<{ exists: boolean; nullable: boolean; dataType: string }> => {
    const r = await sql<{ is_nullable: string; data_type: string }>`
      SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'check_run_tracking'
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

  it('adds a nullable timestamptz terminal_sent_at column', async () => {
    const state = await columnState('terminal_sent_at');
    expect(state.exists).toBe(true);
    expect(state.nullable).toBe(true);
    expect(state.dataType).toBe('timestamp with time zone');
  });

  it('defaults to NULL for a row that was only created', async () => {
    await sql`
      INSERT INTO public.check_run_tracking (provider, owner, repo, sha, check_name, check_run_id)
      VALUES ('github', 'acme', 'app', 'deadbeef', 'kici/build', 42)
    `.execute(db);
    const r = await sql<{ terminal_sent_at: Date | null }>`
      SELECT terminal_sent_at FROM public.check_run_tracking
       WHERE sha = 'deadbeef' AND check_name = 'kici/build'
    `.execute(db);
    expect(r.rows[0]?.terminal_sent_at).toBeNull();
  });

  it('round-trips a stored terminal_sent_at', async () => {
    const stamp = new Date('2026-08-04T12:34:56.000Z');
    await sql`
      UPDATE public.check_run_tracking SET terminal_sent_at = ${stamp}
       WHERE sha = 'deadbeef' AND check_name = 'kici/build'
    `.execute(db);
    const r = await sql<{ terminal_sent_at: Date | null }>`
      SELECT terminal_sent_at FROM public.check_run_tracking
       WHERE sha = 'deadbeef' AND check_name = 'kici/build'
    `.execute(db);
    expect(r.rows[0]?.terminal_sent_at?.toISOString()).toBe(stamp.toISOString());
  });

  it('down() drops the column and up() restores it', async () => {
    await down(db);
    expect((await columnState('terminal_sent_at')).exists).toBe(false);
    await up(db);
    await up(db); // idempotent
    expect((await columnState('terminal_sent_at')).exists).toBe(true);
  });
});
