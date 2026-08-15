import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './112_execution_runs_workflow_repo.js';

/**
 * Real-Postgres test for migration 112: asserts the authoring-repository
 * column exists on `execution_runs` as a nullable text column after migrations
 * 001..112, that it round-trips, and that up/down are idempotent. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig112_test_${process.pid}_${Date.now()}`;

const COLUMN = 'workflow_repo_identifier';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 112_execution_runs_workflow_repo', () => {
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

  it('adds the nullable text authoring-repository column', async () => {
    const state = await columnState('execution_runs', COLUMN);
    expect(state.exists, `${COLUMN} should exist`).toBe(true);
    // Nullable is the whole design: a null means "the run acted on the
    // repository that defines its workflow", which is every per-repository run
    // and every row written before this column existed.
    expect(state.nullable, `${COLUMN} should be nullable`).toBe(true);
    expect(state.dataType, `${COLUMN} should be text`).toBe('text');
  });

  it('round-trips an authoring repository distinct from the acted-on one', async () => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, workflow_repo_identifier)
      VALUES
        (gen_random_uuid(), 'org-ci', 'github', 'acme/app', 'main', 'headsha', 'acme/org-workflows')
    `.execute(db);
    const r = await sql<{ repo_identifier: string; workflow_repo_identifier: string | null }>`
      SELECT repo_identifier, workflow_repo_identifier
        FROM public.execution_runs
       WHERE workflow_name = 'org-ci'
    `.execute(db);
    expect(r.rows[0]?.repo_identifier).toBe('acme/app');
    expect(r.rows[0]?.workflow_repo_identifier).toBe('acme/org-workflows');
  });

  it('down() drops it and up() restores it', async () => {
    await down(db);
    expect((await columnState('execution_runs', COLUMN)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('execution_runs', COLUMN)).exists).toBe(true);
  });
});
