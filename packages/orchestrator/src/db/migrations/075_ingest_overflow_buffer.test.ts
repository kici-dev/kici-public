import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import * as m075 from './075_ingest_overflow_buffer.js';

/**
 * Real-Postgres test for migration 075.
 *
 * Creates a uniquely-named throwaway database, applies migrations 001..075
 * via the production migration provider, and asserts the `ingest_overflow_buffer`
 * table + its `(status, captured_at)` FIFO index exist and behave. The throwaway
 * database is dropped in teardown.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`: skips when unset, fails loudly when
 * set but unreachable.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig075_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 075_ingest_overflow_buffer', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;

  const tableExists = async (): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'ingest_overflow_buffer'
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  const indexExists = async (name: string): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'ingest_overflow_buffer'
           AND indexname = ${name}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

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

  it('creates the ingest_overflow_buffer table and its FIFO + delivery indexes', async () => {
    expect(await tableExists()).toBe(true);
    expect(await indexExists('ingest_overflow_buffer_status_captured_idx')).toBe(true);
    expect(await indexExists('ingest_overflow_buffer_delivery_idx')).toBe(true);
  });

  it('inserts a buffered row with defaulted status/attempts/captured_at', async () => {
    await sql`
      INSERT INTO public.ingest_overflow_buffer
        (delivery_id, routing_key, source_kind, provider, event, action, body)
      VALUES ('d-1', 'github:1', 'direct', 'github', 'push', NULL, ${Buffer.from('{}').toString('base64')})
    `.execute(db);

    const rows = await sql<{
      status: string;
      replay_attempts: number;
      captured_at: Date;
      meta: unknown;
    }>`SELECT status, replay_attempts, captured_at, meta FROM public.ingest_overflow_buffer WHERE delivery_id = 'd-1'`.execute(
      db,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.status).toBe('buffered');
    expect(Number(rows.rows[0]!.replay_attempts)).toBe(0);
    expect(rows.rows[0]!.captured_at).toBeTruthy();
  });

  it('up() is idempotent (re-running is a no-op)', async () => {
    await m075.up(db);
    await m075.up(db);
    expect(await tableExists()).toBe(true);
  });

  it('down() drops the table; up() restores it', async () => {
    await m075.down(db);
    expect(await tableExists()).toBe(false);
    // down() is itself idempotent; up() restores the table.
    await m075.down(db);
    await m075.up(db);
    expect(await tableExists()).toBe(true);
  });
});
