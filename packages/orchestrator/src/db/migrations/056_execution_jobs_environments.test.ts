import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './056_execution_jobs_environments.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig056_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 056_execution_jobs_environments', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const column = async (
    table: string,
    name: string,
  ): Promise<{ data_type: string; is_nullable: string } | null> => {
    const r = await sql<{ data_type: string; is_nullable: string }>`
      SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name=${table} AND column_name=${name}`.execute(db);
    return r.rows[0] ?? null;
  };

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
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

  it('adds a nullable text column', async () => {
    const col = await column('execution_jobs', 'environments');
    expect(col?.data_type).toBe('text');
    expect(col?.is_nullable).toBe('YES');
  });

  it('accepts a JSON array and NULL', async () => {
    const runId = `run-${Date.now()}`;
    const jobId = `job-${Date.now()}`;
    await sql`INSERT INTO public.execution_runs (run_id, workflow_name, provider, repo_identifier, status)
      VALUES (${runId}, 'wf', 'github', 'org/repo', 'pending')`.execute(db);
    await sql`INSERT INTO public.execution_jobs (run_id, job_id, job_name, environments)
      VALUES (${runId}, ${jobId}, 'deploy', ${JSON.stringify(['staging', 'my-testing'])})`.execute(
      db,
    );
    const row = await sql<{ environments: string | null }>`
      SELECT environments FROM public.execution_jobs WHERE job_id=${jobId}`.execute(db);
    expect(JSON.parse(row.rows[0].environments!)).toEqual(['staging', 'my-testing']);

    const jobId2 = `job2-${Date.now()}`;
    await sql`INSERT INTO public.execution_jobs (run_id, job_id, job_name, environments)
      VALUES (${runId}, ${jobId2}, 'noenv', NULL)`.execute(db);
    const row2 = await sql<{ environments: string | null }>`
      SELECT environments FROM public.execution_jobs WHERE job_id=${jobId2}`.execute(db);
    expect(row2.rows[0].environments).toBeNull();
  });

  it('down() drops and up() re-adds the column idempotently', async () => {
    await down(db);
    expect(await column('execution_jobs', 'environments')).toBeNull();
    await up(db);
    await up(db);
    expect(await column('execution_jobs', 'environments')).not.toBeNull();
  });
});
