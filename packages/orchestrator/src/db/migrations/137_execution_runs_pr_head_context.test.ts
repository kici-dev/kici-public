import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './137_execution_runs_pr_head_context.js';
import { terminateTestDbBackends } from '../../__test-helpers__/test-db.js';

/**
 * Real-Postgres test for migration 137: asserts `head_ref`, `head_repository`
 * and `is_fork` exist on `execution_runs` as nullable columns with no default,
 * and that up/down are idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 *
 * The absence of a default is the load-bearing part. `is_fork` defaulting to
 * `false` would let a lost write read as "this was not a fork", which fails
 * OPEN for any cloud trust policy pinning the claim. NULL means NOT RESOLVED
 * and renders as `'unresolved'`, which fails closed.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig137_test_${process.pid}_${Date.now()}`;

const COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['head_ref', 'text'],
  ['head_repository', 'text'],
  ['is_fork', 'boolean'],
];

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 137_execution_runs_pr_head_context', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const columnState = async (
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
         AND table_name = 'execution_runs'
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
      await terminateTestDbBackends(adminPool, TEST_DB);
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it.each(COLUMNS)('adds %s as a nullable %s with no default', async (col, type) => {
    const state = await columnState(col);
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe(type);
    expect(state.nullable).toBe(true);
    expect(state.columnDefault).toBeNull();
  });

  it('leaves a legacy-shaped insert unresolved rather than defaulting is_fork to false', async () => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha)
      VALUES
        (gen_random_uuid(), 'mig137-legacy', 'github', 'acme/app', 'main', 'headsha')
    `.execute(db);
    const r = await sql<{ head_ref: string | null; is_fork: boolean | null }>`
      SELECT head_ref, is_fork FROM public.execution_runs WHERE workflow_name = 'mig137-legacy'
    `.execute(db);
    expect(r.rows[0]?.head_ref).toBeNull();
    expect(r.rows[0]?.is_fork).toBeNull();
  });

  it('stores a fork pull request head distinct from the base ref', async () => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha,
         trigger_event, head_ref, head_repository, is_fork)
      VALUES
        (gen_random_uuid(), 'mig137-forkpr', 'github', 'acme/app', 'main', 'headsha',
         'pull_request:opened', 'main', 'attacker/app', true)
    `.execute(db);
    const r = await sql<{
      ref: string;
      head_ref: string | null;
      head_repository: string | null;
      is_fork: boolean | null;
    }>`
      SELECT ref, head_ref, head_repository, is_fork FROM public.execution_runs
       WHERE workflow_name = 'mig137-forkpr'
    `.execute(db);
    // Same branch NAME on both sides — the collision this column set exists to
    // break is not distinguishable by ref alone.
    expect(r.rows[0]?.ref).toBe('main');
    expect(r.rows[0]?.head_ref).toBe('main');
    expect(r.rows[0]?.head_repository).toBe('attacker/app');
    expect(r.rows[0]?.is_fork).toBe(true);
  });

  it('down() drops every column and up() restores them, idempotently', async () => {
    await down(db);
    for (const [col] of COLUMNS) expect((await columnState(col)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    for (const [col] of COLUMNS) expect((await columnState(col)).exists).toBe(true);
  });
});
