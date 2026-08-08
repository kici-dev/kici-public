import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { up } from './074_normalize_zero_concurrency_limit.js';

/**
 * Real-Postgres test for migration 074. Creates a throwaway database, applies
 * migrations 001..074, seeds three `contexts` rows (limits 0, -2, 5), and asserts
 * up() normalized the non-positive limits to NULL while leaving the positive one
 * intact. A second up() proves idempotency. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig074_test_${process.pid}_${Date.now()}`;

const ID_ZERO = '00000000-0000-4000-a000-000000000001';
const ID_NEG = '00000000-0000-4000-a000-000000000002';
const ID_POS = '00000000-0000-4000-a000-000000000003';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 074_normalize_zero_concurrency_limit', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
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

  it('normalizes non-positive concurrency_limit to NULL and leaves positives intact', async () => {
    await sql`
      INSERT INTO public.contexts (id, org_id, name, type, concurrency_limit)
      VALUES
        (${ID_ZERO}::uuid, 'org-1', 'zero', 'fixed', 0),
        (${ID_NEG}::uuid, 'org-1', 'neg', 'fixed', -2),
        (${ID_POS}::uuid, 'org-1', 'pos', 'fixed', 5)
    `.execute(db);

    // up() already ran via the beforeAll migration; run once more to prove idempotency.
    await up(db);

    const rows = await sql<{ id: string; concurrency_limit: number | null }>`
      SELECT id, concurrency_limit FROM public.contexts ORDER BY id
    `.execute(db);

    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.concurrency_limit]));
    expect(byId[ID_ZERO]).toBeNull();
    expect(byId[ID_NEG]).toBeNull();
    expect(byId[ID_POS]).toBe(5);
  });
});
