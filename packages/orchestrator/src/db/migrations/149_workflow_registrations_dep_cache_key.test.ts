import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './149_workflow_registrations_dep_cache_key.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 149: asserts
 * `workflow_registrations.lockfile_hash` and `workflow_registrations.siblings_digest`
 * exist as nullable text columns after migrations 001..149, that a registration
 * written before them reads both back as null, that `up` is idempotent, and that
 * `down` removes both. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig149_test_${process.pid}_${Date.now()}`;

const COLUMNS = ['lockfile_hash', 'siblings_digest'];

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 149_workflow_registrations_dep_cache_key', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columns = async (): Promise<
    { column_name: string; data_type: string; is_nullable: string }[]
  > => {
    const r = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'workflow_registrations'
         AND column_name IN ('lockfile_hash', 'siblings_digest')
       ORDER BY column_name
    `.execute(db);
    return r.rows;
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

  it('adds lockfile_hash and siblings_digest as nullable text', async () => {
    // fails-when: up() adds neither column, or adds one as NOT NULL
    const rows = await columns();
    expect(rows.map((r) => r.column_name)).toEqual(COLUMNS);
    for (const row of rows) {
      expect(row.data_type).toBe('text');
      expect(row.is_nullable).toBe('YES');
    }
  });

  it('reads a registration written before the columns existed back as null', async () => {
    // breaks-if-wrong: an upgraded database's registrations must keep loading, with no dependency-cache key
    await down(db);
    await sql`
      INSERT INTO public.workflow_registrations
        (repo_identifier, workflow_name, lock_entry, trigger_types, customer_id)
      VALUES ('org/ci', 'org-lint', '{}'::jsonb, ARRAY['push'], 'org-1')
    `.execute(db);
    await up(db);

    const row = await sql<{ lockfile_hash: string | null; siblings_digest: string | null }>`
      SELECT lockfile_hash, siblings_digest FROM public.workflow_registrations
       WHERE workflow_name = 'org-lint'
    `.execute(db);
    expect(row.rows).toEqual([{ lockfile_hash: null, siblings_digest: null }]);
  });

  it('re-running up() is a no-op, and down() removes both columns', async () => {
    // breaks-if-wrong: re-running up on an already-upgraded database must not throw
    await up(db);
    expect((await columns()).map((r) => r.column_name)).toEqual(COLUMNS);

    // fails-when: down() leaves either column behind
    await down(db);
    expect(await columns()).toEqual([]);

    await up(db);
    expect((await columns()).map((r) => r.column_name)).toEqual(COLUMNS);
  });
});
