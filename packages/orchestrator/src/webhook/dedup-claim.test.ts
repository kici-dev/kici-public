import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { DedupCache } from './dedup.js';

// Real-Postgres cluster-correctness test for the atomic dedup claim. Gated on
// KICI_TEST_ADMIN_DATABASE_URL — the mock-based coverage lives in dedup.test.ts;
// this file proves the ON CONFLICT arbiter against a real unique constraint so
// two concurrent claims on the same delivery yield exactly one winner.
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_dedup_claim_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('DedupCache.claim — atomic cluster-wide claim (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [TEST_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  it('first claim wins, second claim on the same id is a duplicate', async () => {
    const cache = new DedupCache(db);
    expect(await cache.claim('delivery-1')).toBe(true);
    expect(await cache.claim('delivery-1')).toBe(false);
  });

  it('two simulated instances (separate caches, shared DB) — exactly one wins the race', async () => {
    // Each DedupCache has its own in-memory set, modelling two orchestrator
    // instances behind an LB that both receive the same X-GitHub-Delivery.
    const instanceA = new DedupCache(db);
    const instanceB = new DedupCache(db);
    const [a, b] = await Promise.all([instanceA.claim('race-1'), instanceB.claim('race-1')]);
    expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one true
  });

  it('distinct delivery ids both win', async () => {
    const cache = new DedupCache(db);
    expect(await cache.claim('k-a')).toBe(true);
    expect(await cache.claim('k-b')).toBe(true);
  });
});
