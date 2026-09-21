import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './143_execution_jobs_precursor_result.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 143: asserts
 * `execution_jobs.precursor_result` exists as a nullable jsonb column with no
 * default after migrations 001..143, round-trips a precursor payload, and that
 * up/down are idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * Nullability is the load-bearing part: NULL means "this job reported no
 * precursor payload", which is true of every ordinary job and of every row
 * written before the column existed.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig143_test_${process.pid}_${Date.now()}`;

const COLUMN = 'precursor_result';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 143_execution_jobs_precursor_result', () => {
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
         AND table_name = 'execution_jobs'
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

  it('adds the column as nullable jsonb with no default', async () => {
    const state = await columnState();
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('jsonb');
    expect(state.nullable).toBe(true);
    expect(state.columnDefault).toBeNull();
  });

  it('leaves an ordinary job NULL', async () => {
    const runId = '11111111-1111-4111-8111-111111111143';
    await seedRun(runId, 'mig143-none');
    await sql`
      INSERT INTO public.execution_jobs (run_id, job_id, job_name)
      VALUES (${runId}::uuid, 'job-none', 'test')
    `.execute(db);
    const r = await sql<{ precursor_result: unknown }>`
      SELECT precursor_result FROM public.execution_jobs
       WHERE run_id = ${runId}::uuid AND job_id = 'job-none'
    `.execute(db);
    expect(r.rows[0]?.precursor_result).toBeNull();
  });

  it('round-trips an init result payload', async () => {
    const runId = '22222222-2222-4222-8222-222222222143';
    await seedRun(runId, 'mig143-init');
    const payload = { initComplete: true, initResult: { env: { A: '1' }, filterPassed: true } };
    await sql`
      INSERT INTO public.execution_jobs (run_id, job_id, job_name, precursor_result)
      VALUES (${runId}::uuid, 'job-init', '__init__x', ${JSON.stringify(payload)}::jsonb)
    `.execute(db);
    const r = await sql<{ precursor_result: unknown }>`
      SELECT precursor_result FROM public.execution_jobs
       WHERE run_id = ${runId}::uuid AND job_id = 'job-init'
    `.execute(db);
    expect(r.rows[0]?.precursor_result).toEqual(payload);
  });

  it('down() drops it and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState()).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState()).exists).toBe(true);
  });
});
