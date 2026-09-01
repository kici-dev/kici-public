import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';

/**
 * Real-Postgres test for migration 116: `org_plan_headroom` is created with the
 * single-row shape the PlanHeadroomStore writes — a `varchar(16)` primary key,
 * the three integer ceiling columns, a boolean `evict_excess` defaulting false,
 * and a NOT NULL `updated_at`. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig116_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 116_org_plan_headroom', () => {
  let db: Kysely<never>;
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
    db = new Kysely<never>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await migrateToOwnMigration(db, import.meta.url);
    if (error) throw error;
  }, 120_000);

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
  });

  it('stores a single ceiling row with evict_excess defaulting to false', async () => {
    await sql`
      INSERT INTO public.org_plan_headroom
        (id, max_worker_peers, org_limit, org_total, updated_at)
      VALUES ('default', 3, 5, 2, now())
    `.execute(db);

    const row = await sql<{
      max_worker_peers: number;
      org_limit: number;
      org_total: number;
      evict_excess: boolean;
    }>`
      SELECT max_worker_peers, org_limit, org_total, evict_excess
        FROM public.org_plan_headroom WHERE id = 'default'
    `.execute(db);
    expect(Number(row.rows[0].max_worker_peers)).toBe(3);
    expect(Number(row.rows[0].org_limit)).toBe(5);
    expect(Number(row.rows[0].org_total)).toBe(2);
    expect(row.rows[0].evict_excess).toBe(false);
  });

  it('rejects a second row under the same primary key', async () => {
    await sql`
      INSERT INTO public.org_plan_headroom
        (id, max_worker_peers, org_limit, org_total, updated_at)
      VALUES ('default', 0, 5, 6, now())
      ON CONFLICT (id) DO UPDATE SET max_worker_peers = excluded.max_worker_peers,
        org_total = excluded.org_total, evict_excess = true
    `.execute(db);

    const row = await sql<{ count: string; max_worker_peers: number; evict_excess: boolean }>`
      SELECT count(*)::text AS count,
             max(max_worker_peers) AS max_worker_peers,
             bool_or(evict_excess) AS evict_excess
        FROM public.org_plan_headroom
    `.execute(db);
    expect(Number(row.rows[0].count)).toBe(1);
    expect(Number(row.rows[0].max_worker_peers)).toBe(0);
    expect(row.rows[0].evict_excess).toBe(true);
  });
});
