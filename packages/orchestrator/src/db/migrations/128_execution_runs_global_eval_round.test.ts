import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './128_execution_runs_global_eval_round.js';

/**
 * Real-Postgres test for migration 128: asserts
 * `execution_runs.is_global_eval_round` exists as a NOT NULL boolean defaulting
 * to false after migrations 001..128, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * The default is the load-bearing part: the re-run path branches on this column,
 * so a null would make an ordinary run's routing depend on a three-valued read
 * when the question has exactly two answers.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig128_test_${process.pid}_${Date.now()}`;

const COLUMN = 'is_global_eval_round';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 128_execution_runs_global_eval_round', () => {
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

  it('adds the column as a NOT NULL boolean defaulting to false', async () => {
    const state = await columnState('execution_runs', COLUMN);
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('boolean');
    expect(state.nullable).toBe(false);
    expect(state.columnDefault).toBe('false');
  });

  it('defaults an ordinary run row to false', async () => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha)
      VALUES
        (gen_random_uuid(), 'mig128-ordinary', 'github', 'acme/app', 'main', 'headsha')
    `.execute(db);
    const r = await sql<{ is_global_eval_round: boolean }>`
      SELECT is_global_eval_round FROM public.execution_runs
       WHERE workflow_name = 'mig128-ordinary'
    `.execute(db);
    expect(r.rows[0]?.is_global_eval_round).toBe(false);
  });

  it('stores a round-marked row as true', async () => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, is_global_eval_round)
      VALUES
        (gen_random_uuid(), 'mig128-round', 'github', 'acme/app', 'main', 'headsha', TRUE)
    `.execute(db);
    const r = await sql<{ is_global_eval_round: boolean }>`
      SELECT is_global_eval_round FROM public.execution_runs
       WHERE workflow_name = 'mig128-round'
    `.execute(db);
    expect(r.rows[0]?.is_global_eval_round).toBe(true);
  });

  it('down() drops it and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState('execution_runs', COLUMN)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('execution_runs', COLUMN)).exists).toBe(true);
  });
});
