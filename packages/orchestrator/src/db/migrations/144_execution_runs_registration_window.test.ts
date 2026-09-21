import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './144_execution_runs_registration_window.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 144: asserts
 * `execution_runs.registration_window_instance_id` exists as a nullable text
 * column with no default after migrations 001..144, round-trips an instance
 * id, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * Nullability is the load-bearing part: NULL means "no coordinator has a
 * registration window open on this run", which is true of every run whose
 * owner released its window and of every row written before the column
 * existed.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig144_test_${process.pid}_${Date.now()}`;

const COLUMN = 'registration_window_instance_id';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 144_execution_runs_registration_window', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (): Promise<{
    exists: boolean;
    nullable: boolean;
    dataType: string;
    columnDefault: string | null;
  }> => {
    const r = await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
      SELECT is_nullable, data_type, column_default FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_runs'
         AND column_name = ${COLUMN}
    `.execute(db);
    const row = r.rows[0];
    return {
      exists: row !== undefined,
      nullable: row?.is_nullable === 'YES',
      dataType: row?.data_type ?? '',
      columnDefault: row?.column_default ?? null,
    };
  };

  const seedRun = async (runId: string, workflowName: string): Promise<void> => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha)
      VALUES
        (${runId}::uuid, ${workflowName}, 'github', 'acme/app', 'main', 'headsha')
    `.execute(db);
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

  it('adds the column as nullable text with no default', async () => {
    const state = await columnState();
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('text');
    expect(state.nullable).toBe(true);
    expect(state.columnDefault).toBeNull();
  });

  it('leaves a run with no open window NULL', async () => {
    // fails-when: the column gains a default — every pre-existing run would
    // read as held by a phantom coordinator.
    const runId = '11111111-1111-4111-8111-111111111144';
    await seedRun(runId, 'mig144-none');
    const r = await sql<{ registration_window_instance_id: string | null }>`
      SELECT registration_window_instance_id FROM public.execution_runs
       WHERE run_id = ${runId}::uuid
    `.execute(db);
    expect(r.rows[0]?.registration_window_instance_id).toBeNull();
  });

  it('round-trips a holder id and clears back to NULL', async () => {
    const runId = '22222222-2222-4222-8222-222222222144';
    await seedRun(runId, 'mig144-held');
    await sql`
      UPDATE public.execution_runs SET registration_window_instance_id = 'coord-b'
       WHERE run_id = ${runId}::uuid
    `.execute(db);
    const held = await sql<{ registration_window_instance_id: string | null }>`
      SELECT registration_window_instance_id FROM public.execution_runs
       WHERE run_id = ${runId}::uuid
    `.execute(db);
    expect(held.rows[0]?.registration_window_instance_id).toBe('coord-b');

    await sql`
      UPDATE public.execution_runs SET registration_window_instance_id = NULL
       WHERE run_id = ${runId}::uuid AND registration_window_instance_id = 'coord-b'
    `.execute(db);
    const cleared = await sql<{ registration_window_instance_id: string | null }>`
      SELECT registration_window_instance_id FROM public.execution_runs
       WHERE run_id = ${runId}::uuid
    `.execute(db);
    expect(cleared.rows[0]?.registration_window_instance_id).toBeNull();
  });

  it('down() drops it and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState()).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState()).exists).toBe(true);
  });
});
