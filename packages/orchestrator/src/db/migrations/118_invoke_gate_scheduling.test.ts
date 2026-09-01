import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './118_invoke_gate_scheduling.js';

/**
 * Real-Postgres test for migration 118: asserts the invoke-gate scheduling
 * columns exist after migrations 001..118, that `chain_depth` defaults to 0, and
 * that up/down are idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig118_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 118_invoke_gate_scheduling', () => {
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

  it('adds timeout_ms, chain_depth, and invoke_config columns', async () => {
    const timeout = await columnState('execution_jobs', 'timeout_ms');
    expect(timeout.exists).toBe(true);
    expect(timeout.nullable).toBe(true);
    expect(timeout.dataType).toBe('integer');

    const chainDepth = await columnState('execution_runs', 'chain_depth');
    expect(chainDepth.exists).toBe(true);
    expect(chainDepth.nullable).toBe(false);
    expect(chainDepth.dataType).toBe('integer');

    const invokeConfig = await columnState('pending_job_contexts', 'invoke_config');
    expect(invokeConfig.exists).toBe(true);
    expect(invokeConfig.nullable).toBe(true);
  });

  it('chain_depth defaults to 0 for a plain run row', async () => {
    const runId = '00000000-0000-0000-0000-000000000118';
    await sql`
      INSERT INTO public.execution_runs (run_id, workflow_name, provider, repo_identifier, ref, sha)
      VALUES (${runId}, 'ci', 'github', 'acme/app', 'main', 'headsha')
    `.execute(db);
    const r = await sql<{ chain_depth: number }>`
      SELECT chain_depth FROM public.execution_runs WHERE run_id = ${runId}
    `.execute(db);
    expect(r.rows[0]?.chain_depth).toBe(0);
  });

  it('down() drops the columns and up() restores them', async () => {
    await down(db);
    expect((await columnState('execution_jobs', 'timeout_ms')).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('execution_jobs', 'timeout_ms')).exists).toBe(true);
    expect((await columnState('execution_runs', 'chain_depth')).exists).toBe(true);
    expect((await columnState('pending_job_contexts', 'invoke_config')).exists).toBe(true);
  });
});
