import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { down, up } from './057_step_concurrency.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig057_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 057_step_concurrency', () => {
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

  it('adds nullable text concurrency columns', async () => {
    const ck = await column('execution_steps', 'concurrency_kind');
    const gid = await column('execution_steps', 'group_id');
    expect(ck?.data_type).toBe('text');
    expect(ck?.is_nullable).toBe('YES');
    expect(gid?.data_type).toBe('text');
    expect(gid?.is_nullable).toBe('YES');
  });

  it('inserts a parallel-child row through the typed columns', async () => {
    const runId = `run-${Date.now()}`;
    const jobId = `job-${Date.now()}`;
    await sql`INSERT INTO public.execution_runs (run_id, workflow_name, provider, repo_identifier, status)
      VALUES (${runId}, 'wf', 'github', 'org/repo', 'pending')`.execute(db);
    await sql`INSERT INTO public.execution_steps
      (run_id, job_id, step_index, step_name, status, concurrency_kind, group_id)
      VALUES (${runId}, ${jobId}, 1, 'lint', 'cancelled', 'parallel-child', 'g0')`.execute(db);
    const row = await sql<{ concurrency_kind: string | null; group_id: string | null }>`
      SELECT concurrency_kind, group_id FROM public.execution_steps
        WHERE run_id=${runId} AND job_id=${jobId} AND step_index=1`.execute(db);
    expect(row.rows[0].concurrency_kind).toBe('parallel-child');
    expect(row.rows[0].group_id).toBe('g0');
  });

  it('down() drops and up() re-adds the columns idempotently', async () => {
    await down(db);
    expect(await column('execution_steps', 'concurrency_kind')).toBeNull();
    expect(await column('execution_steps', 'group_id')).toBeNull();
    await up(db);
    await up(db);
    expect(await column('execution_steps', 'concurrency_kind')).not.toBeNull();
    expect(await column('execution_steps', 'group_id')).not.toBeNull();
  });
});
