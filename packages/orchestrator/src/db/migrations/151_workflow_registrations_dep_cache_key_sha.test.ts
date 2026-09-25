import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './151_workflow_registrations_dep_cache_key_sha.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 151: asserts
 * `workflow_registrations.dep_cache_key_sha` exists as a nullable text column
 * after migrations 001..151, that a registration written before it reads back
 * null, that `up` is idempotent, and that `down` removes it. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig151_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 151_workflow_registrations_dep_cache_key_sha', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const column = async (): Promise<{ data_type: string; is_nullable: string }[]> => {
    const r = await sql<{ data_type: string; is_nullable: string }>`
      SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'workflow_registrations'
         AND column_name = 'dep_cache_key_sha'
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

  it('adds dep_cache_key_sha as nullable text', async () => {
    // fails-when: up() does not add the column, or adds it as NOT NULL
    expect(await column()).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
  });

  it('reads a registration written before the column existed back as null', async () => {
    // breaks-if-wrong: an upgraded database's registrations must keep loading, with no
    // commit the key was written for, so none of them uses its key
    await down(db);
    await sql`
      INSERT INTO public.workflow_registrations
        (repo_identifier, workflow_name, lock_entry, trigger_types, customer_id,
         commit_sha, lockfile_hash)
      VALUES ('org/ci', 'org-lint', '{}'::jsonb, ARRAY['push'], 'org-1', 'a1', 'lock-a0')
    `.execute(db);
    await up(db);

    const row = await sql<{ dep_cache_key_sha: string | null }>`
      SELECT dep_cache_key_sha FROM public.workflow_registrations
       WHERE workflow_name = 'org-lint'
    `.execute(db);
    expect(row.rows).toEqual([{ dep_cache_key_sha: null }]);
  });

  it('re-running up() is a no-op, and down() removes the column', async () => {
    // breaks-if-wrong: re-running up on an already-upgraded database must not throw
    await up(db);
    expect(await column()).toHaveLength(1);

    // fails-when: down() leaves the column behind
    await down(db);
    expect(await column()).toEqual([]);

    await up(db);
    expect(await column()).toHaveLength(1);
  });
});
