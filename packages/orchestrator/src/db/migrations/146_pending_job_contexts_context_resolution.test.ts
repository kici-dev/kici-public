import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './146_pending_job_contexts_context_resolution.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 146: asserts
 * `pending_job_contexts.context_resolution` exists as a nullable jsonb column
 * after migrations 001..146, that a row written without it reads back null,
 * that `up` is idempotent on an upgraded database, and that `down` removes it.
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig146_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 146_pending_job_contexts_context_resolution', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const column = async (): Promise<{ data_type: string; is_nullable: string }[]> => {
    const r = await sql<{ data_type: string; is_nullable: string }>`
      SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'pending_job_contexts'
         AND column_name = 'context_resolution'
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

  it('adds context_resolution as nullable jsonb, null on a row that omits it', async () => {
    // fails-when: up() does not add the column, or adds it NOT NULL or as text
    expect(await column()).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]);
    // breaks-if-wrong: a pending context written without the column must still insert
    await sql`
      INSERT INTO public.pending_job_contexts (run_id, job_name, job_input, runs_on_labels)
      VALUES ('run-146', 'build', '{}'::jsonb, '[]'::jsonb)
    `.execute(db);
    const r = await sql<{ context_resolution: unknown }>`
      SELECT context_resolution FROM public.pending_job_contexts WHERE run_id = 'run-146'
    `.execute(db);
    expect(r.rows).toEqual([{ context_resolution: null }]);
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
