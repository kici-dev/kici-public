import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './108_unroutable_fast_fail.js';

/**
 * Real-Postgres test for migration 108: asserts the three unroutable fast-fail
 * columns exist with the right nullability and types after migrations 001..108,
 * and that up/down are idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig108_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 108_unroutable_fast_fail', () => {
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

  it('adds all three nullable columns with the right types', async () => {
    const grace = await columnState('cluster_settings', 'unroutable_grace_ms');
    expect(grace.exists).toBe(true);
    expect(grace.nullable).toBe(true);
    expect(grace.dataType).toBe('integer');

    const since = await columnState('dispatch_queue', 'unroutable_since');
    expect(since.exists).toBe(true);
    expect(since.nullable).toBe(true);
    expect(since.dataType).toBe('timestamp with time zone');

    const reason = await columnState('execution_jobs', 'routing_reason');
    expect(reason.exists).toBe(true);
    expect(reason.nullable).toBe(true);
    expect(reason.dataType).toBe('text');
  });

  it('round-trips a stored unroutable_grace_ms', async () => {
    await sql`
      INSERT INTO public.cluster_settings (id, unroutable_grace_ms)
      VALUES ('default', 120000)
      ON CONFLICT (id) DO UPDATE
        SET unroutable_grace_ms = EXCLUDED.unroutable_grace_ms
    `.execute(db);
    const r = await sql<{ unroutable_grace_ms: string | number | null }>`
      SELECT unroutable_grace_ms FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(Number(r.rows[0]?.unroutable_grace_ms)).toBe(120000);
  });

  it('accepts 0, the documented value that disables fast-fail', async () => {
    await sql`
      INSERT INTO public.cluster_settings (id, unroutable_grace_ms)
      VALUES ('default', 0)
      ON CONFLICT (id) DO UPDATE
        SET unroutable_grace_ms = EXCLUDED.unroutable_grace_ms
    `.execute(db);
    const r = await sql<{ unroutable_grace_ms: string | number | null }>`
      SELECT unroutable_grace_ms FROM public.cluster_settings WHERE id = 'default'
    `.execute(db);
    expect(Number(r.rows[0]?.unroutable_grace_ms)).toBe(0);
  });

  it('down() drops all three and up() restores them', async () => {
    await down(db);
    expect((await columnState('cluster_settings', 'unroutable_grace_ms')).exists).toBe(false);
    expect((await columnState('dispatch_queue', 'unroutable_since')).exists).toBe(false);
    expect((await columnState('execution_jobs', 'routing_reason')).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('cluster_settings', 'unroutable_grace_ms')).exists).toBe(true);
    expect((await columnState('dispatch_queue', 'unroutable_since')).exists).toBe(true);
    expect((await columnState('execution_jobs', 'routing_reason')).exists).toBe(true);
  });
});
