import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, SEALED_SECRETS_TABLES, up } from './147_sealed_job_secrets.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 147: asserts `sealed_secrets` exists as a
 * nullable text column on each table a job waits in after migrations 001..147,
 * that a row written without it reads back null, that `up` is idempotent, and
 * that `down` removes it. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig147_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 147_sealed_job_secrets', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columns = async (): Promise<
    { table_name: string; data_type: string; is_nullable: string }[]
  > => {
    const r = await sql<{ table_name: string; data_type: string; is_nullable: string }>`
      SELECT table_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'sealed_secrets'
       ORDER BY table_name
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

  it('adds sealed_secrets as nullable text to every table a job waits in', async () => {
    // fails-when: up() skips a table, or adds the column NOT NULL or as another type
    expect(await columns()).toEqual(
      [...SEALED_SECRETS_TABLES].sort().map((table_name) => ({
        table_name,
        data_type: 'text',
        is_nullable: 'YES',
      })),
    );
    // breaks-if-wrong: a pending context written without the column must still insert
    await sql`
      INSERT INTO public.pending_job_contexts (run_id, job_name, job_input, runs_on_labels)
      VALUES ('run-147', 'build', '{}'::jsonb, '[]'::jsonb)
    `.execute(db);
    const r = await sql<{ sealed_secrets: unknown }>`
      SELECT sealed_secrets FROM public.pending_job_contexts WHERE run_id = 'run-147'
    `.execute(db);
    expect(r.rows).toEqual([{ sealed_secrets: null }]);
  });

  it('re-running up() is a no-op, and down() removes the columns', async () => {
    // breaks-if-wrong: re-running up on an already-upgraded database must not throw
    await up(db);
    expect(await columns()).toHaveLength(SEALED_SECRETS_TABLES.length);

    // fails-when: down() leaves a column behind
    await down(db);
    expect(await columns()).toEqual([]);

    await up(db);
    expect(await columns()).toHaveLength(SEALED_SECRETS_TABLES.length);
  });
});
