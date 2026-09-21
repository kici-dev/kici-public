import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './131_execution_jobs_git_credentials.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 131: asserts
 * `execution_jobs.git_credentials` exists as a nullable jsonb column with no
 * default after migrations 001..131, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * Nullability is the load-bearing part: NULL means "this job declared no git
 * credentials", which is true of nearly every job and of every row written
 * before the column existed, so a default would have to name a declaration
 * nobody made.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig131_test_${process.pid}_${Date.now()}`;

const COLUMN = 'git_credentials';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 131_execution_jobs_git_credentials', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
    table: string,
    col: string,
  ): Promise<{
    exists: boolean;
    nullable: boolean;
    dataType: string;
    columnDefault: string | null;
  }> => {
    const r = await sql<{ is_nullable: string; data_type: string; column_default: string | null }>`
      SELECT is_nullable, data_type, column_default FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ${table}
         AND column_name = ${col}
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
    const state = await columnState('execution_jobs', COLUMN);
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('jsonb');
    expect(state.nullable).toBe(true);
    expect(state.columnDefault).toBeNull();
  });

  it('leaves a job that declared no git credentials NULL', async () => {
    const runId = '11111111-1111-4111-8111-111111111131';
    await seedRun(runId, 'mig131-none');
    await sql`
      INSERT INTO public.execution_jobs (run_id, job_id, job_name)
      VALUES (${runId}::uuid, 'job-none', 'build')
    `.execute(db);
    const r = await sql<{ git_credentials: unknown }>`
      SELECT git_credentials FROM public.execution_jobs
       WHERE run_id = ${runId}::uuid AND job_id = 'job-none'
    `.execute(db);
    expect(r.rows[0]?.git_credentials).toBeNull();
  });

  it('stores a declared credential map as secret names, not material', async () => {
    const runId = '22222222-2222-4222-8222-222222222131';
    await seedRun(runId, 'mig131-declared');
    const declared = { forge: { kind: 'token', tokenSecret: 'ci:FORGE_PAT' } };
    await sql`
      INSERT INTO public.execution_jobs (run_id, job_id, job_name, git_credentials)
      VALUES (${runId}::uuid, 'job-declared', 'push', ${JSON.stringify(declared)}::jsonb)
    `.execute(db);
    const r = await sql<{ git_credentials: unknown }>`
      SELECT git_credentials FROM public.execution_jobs
       WHERE run_id = ${runId}::uuid AND job_id = 'job-declared'
    `.execute(db);
    expect(r.rows[0]?.git_credentials).toEqual(declared);
  });

  it('down() drops it and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState('execution_jobs', COLUMN)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('execution_jobs', COLUMN)).exists).toBe(true);
  });
});
