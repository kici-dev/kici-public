import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './150_execution_runs_status_epoch.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 150: asserts `execution_runs.status_epoch`
 * exists as a NOT NULL integer defaulting to 0 after migrations 001..150, that a
 * run written before the column reads 0, and that up/down are idempotent. Gated
 * on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig150_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 150_execution_runs_status_epoch', () => {
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
         AND column_name = 'status_epoch'
    `.execute(db);
    const row = r.rows[0];
    return {
      exists: row !== undefined,
      nullable: row?.is_nullable === 'YES',
      dataType: row?.data_type ?? '',
      columnDefault: row?.column_default ?? null,
    };
  };

  const insertRun = async (runId: string): Promise<void> => {
    await sql`INSERT INTO public.execution_runs (run_id, workflow_name, provider, repo_identifier, ref, sha, status)
      VALUES (${runId}, 'wf', 'github', 'org/repo', 'refs/heads/main', 'deadbeef', 'failed')`.execute(
      db,
    );
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

  it('adds a NOT NULL integer status_epoch column defaulting to 0', async () => {
    const state = await columnState();
    expect(state.exists).toBe(true);
    expect(state.nullable).toBe(false);
    expect(state.dataType).toBe('integer');
    expect(state.columnDefault).toBe('0');
  });

  it('reads 0 on a run written before the column existed', async () => {
    await down(db);
    const runId = randomUUID();
    await insertRun(runId);
    await up(db);
    const r = await sql<{ status_epoch: number }>`
      SELECT status_epoch FROM public.execution_runs WHERE run_id = ${runId}`.execute(db);
    // fails-when: the column is added without a default — an existing run has no generation.
    expect(r.rows[0]?.status_epoch).toBe(0);
  });

  it('down() drops the column and up() restores it idempotently', async () => {
    await down(db);
    expect((await columnState()).exists).toBe(false);
    await up(db);
    await up(db);
    expect((await columnState()).exists).toBe(true);
  });
});
