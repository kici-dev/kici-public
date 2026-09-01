import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './117_invoke_gate_proxy_jobs.js';

/**
 * Real-Postgres test for migration 117: asserts the proxy-job + summon
 * correlation columns exist after migrations 001..117, that `job_kind` defaults
 * to 'standard', and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig117_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 117_invoke_gate_proxy_jobs', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
    table: string,
    col: string,
  ): Promise<{ exists: boolean; nullable: boolean; dataType: string }> => {
    const r = await sql<{ is_nullable: string; data_type: string }>`
      SELECT is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${col}
    `.execute(db);
    const row = r.rows[0];
    return {
      exists: row !== undefined,
      nullable: row?.is_nullable === 'YES',
      dataType: row?.data_type ?? '',
    };
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
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('adds job_kind, summoned_run_id, and summon-correlation columns', async () => {
    const jobKind = await columnState('execution_jobs', 'job_kind');
    expect(jobKind.exists).toBe(true);
    expect(jobKind.nullable).toBe(false);
    expect(jobKind.dataType).toBe('text');

    const summonedRunId = await columnState('execution_jobs', 'summoned_run_id');
    expect(summonedRunId.exists).toBe(true);
    expect(summonedRunId.nullable).toBe(true);

    const byRun = await columnState('execution_runs', 'summoned_by_run_id');
    expect(byRun.exists).toBe(true);
    expect(byRun.nullable).toBe(true);

    const byProxy = await columnState('execution_runs', 'summoned_by_proxy_job');
    expect(byProxy.exists).toBe(true);
    expect(byProxy.nullable).toBe(true);
  });

  it("job_kind defaults to 'standard' for a plain job row", async () => {
    const runId = '00000000-0000-0000-0000-000000000117';
    await sql`
      INSERT INTO public.execution_runs (run_id, workflow_name, provider, repo_identifier, ref, sha)
      VALUES (${runId}, 'ci', 'github', 'acme/app', 'main', 'headsha')
    `.execute(db);
    await sql`
      INSERT INTO public.execution_jobs (job_id, run_id, job_name)
      VALUES ('job-117', ${runId}, 'build')
    `.execute(db);
    const r = await sql<{ job_kind: string }>`
      SELECT job_kind FROM public.execution_jobs WHERE job_id = 'job-117'
    `.execute(db);
    expect(r.rows[0]?.job_kind).toBe('standard');
  });

  it('down() drops the columns and up() restores them', async () => {
    await down(db);
    expect((await columnState('execution_jobs', 'job_kind')).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('execution_jobs', 'job_kind')).exists).toBe(true);
    expect((await columnState('execution_runs', 'summoned_by_proxy_job')).exists).toBe(true);
  });
});
