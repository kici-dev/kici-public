import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './071_batch_accumulation.js';

/**
 * Real-Postgres test for migration 071. Creates a throwaway database, applies
 * migrations 001..071, and asserts the batch-accumulation tables + their columns
 * exist, the open-once unique index is present, and the item→window cascade
 * fires. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig071_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 071_batch_accumulation', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const tableExists = async (name: string): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${name}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  const columns = async (table: string): Promise<string[]> => {
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ${table}
    `.execute(db);
    return result.rows.map((r) => r.column_name).sort();
  };

  const indexExists = async (table: string, index: string): Promise<boolean> => {
    const result = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE tablename = ${table} AND indexname = ${index}
    `.execute(db);
    return result.rows.length === 1;
  };

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

  it('creates both tables with the expected columns and open-once index', async () => {
    expect(await tableExists('batch_accumulation_windows')).toBe(true);
    expect(await tableExists('batch_accumulation_items')).toBe(true);
    expect(await columns('batch_accumulation_windows')).toEqual(
      [
        'accumulate_for_ms',
        'customer_id',
        'expires_at',
        'id',
        'opened_at',
        'registration_id',
        'repo_identifier',
        'routing_key',
      ].sort(),
    );
    expect(await columns('batch_accumulation_items')).toEqual(
      [
        'created_at',
        'failure_class',
        'id',
        'repo_identifier',
        'run_id',
        'sender_username',
        'window_id',
        'workflow_name',
      ].sort(),
    );
    expect(
      await indexExists('batch_accumulation_windows', 'uq_batch_accumulation_windows_registration'),
    ).toBe(true);
  });

  it('enforces open-once on registration_id and cascades item deletes', async () => {
    await sql`
      INSERT INTO public.batch_accumulation_windows
        (id, customer_id, registration_id, routing_key, repo_identifier, accumulate_for_ms, expires_at)
      VALUES (gen_random_uuid(), 'cust', 'reg-1', 'github:1', 'org/repo', 5000, NOW() + INTERVAL '5 seconds')
    `.execute(db);

    // Second insert for the same registration violates open-once.
    await expect(
      sql`
        INSERT INTO public.batch_accumulation_windows
          (id, customer_id, registration_id, routing_key, repo_identifier, accumulate_for_ms, expires_at)
        VALUES (gen_random_uuid(), 'cust', 'reg-1', 'github:1', 'org/repo', 5000, NOW() + INTERVAL '5 seconds')
      `.execute(db),
    ).rejects.toThrow();

    const win = await sql<{ id: string }>`
      SELECT id FROM public.batch_accumulation_windows WHERE registration_id = 'reg-1'
    `.execute(db);
    const windowId = win.rows[0]!.id;

    await sql`
      INSERT INTO public.batch_accumulation_items
        (id, window_id, run_id, repo_identifier, workflow_name)
      VALUES (gen_random_uuid(), ${windowId}, 'run-1', 'org/repo', 'CI')
    `.execute(db);

    await sql`DELETE FROM public.batch_accumulation_windows WHERE id = ${windowId}`.execute(db);
    const items = await sql<{ count: string }>`
      SELECT COUNT(*)::text AS count FROM public.batch_accumulation_items WHERE window_id = ${windowId}
    `.execute(db);
    expect(items.rows[0]!.count).toBe('0');
  });

  it('down() drops both tables; up() recreates idempotently', async () => {
    await down(db);
    expect(await tableExists('batch_accumulation_windows')).toBe(false);
    expect(await tableExists('batch_accumulation_items')).toBe(false);
    await up(db);
    await up(db); // idempotent (existence guard)
    expect(await tableExists('batch_accumulation_windows')).toBe(true);
    expect(await tableExists('batch_accumulation_items')).toBe(true);
  });
});
