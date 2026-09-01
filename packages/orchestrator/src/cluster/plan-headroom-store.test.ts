import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import { PlanHeadroomStore } from './plan-headroom-store.js';
import type { Database } from '../db/types.js';

/**
 * Real-Postgres test for PlanHeadroomStore. The store's whole reason to exist is
 * that the ceiling SURVIVES a restart, which a mocked query builder cannot show.
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_planheadroom_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('PlanHeadroomStore', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  let store: PlanHeadroomStore;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
    store = new PlanHeadroomStore(db);
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

  it('round-trips a pushed ceiling', async () => {
    expect(await store.read()).toBeNull();

    await store.write({
      type: 'plan.headroom',
      maxWorkerPeers: 3,
      orgLimit: 5,
      orgTotal: 2,
      evictExcess: false,
    });

    const stored = await store.read();
    expect(stored?.maxWorkerPeers).toBe(3);
    expect(stored?.evictExcess).toBe(false);
  });

  it('overwrites the single row rather than accumulating', async () => {
    await store.write({
      type: 'plan.headroom',
      maxWorkerPeers: 3,
      orgLimit: 5,
      orgTotal: 2,
      evictExcess: false,
    });
    await store.write({
      type: 'plan.headroom',
      maxWorkerPeers: 0,
      orgLimit: 5,
      orgTotal: 6,
      evictExcess: true,
    });
    expect((await store.read())?.maxWorkerPeers).toBe(0);
    expect((await store.read())?.evictExcess).toBe(true);
  });
});
