import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import { up } from './061_execution_runs_environment_id.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig061_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 061_execution_runs_environment_id', () => {
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

  const fkTarget = async (): Promise<string | null> => {
    const r = await sql<{ foreign_table: string }>`
      SELECT ccu.table_name AS foreign_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_name = 'execution_runs'
         AND kcu.column_name = 'environment_id'`.execute(db);
    return r.rows[0]?.foreign_table ?? null;
  };

  const envId = async (runId: string): Promise<string | null> => {
    const r = await sql<{ environment_id: string | null }>`
      SELECT environment_id FROM public.execution_runs WHERE run_id = ${runId}`.execute(db);
    return r.rows[0]?.environment_id ?? null;
  };

  const insertEnv = async (orgId: string, name: string, type: string): Promise<string> => {
    const r = await sql<{ id: string }>`
      INSERT INTO public.environments (org_id, name, type, glob_pattern)
      VALUES (${orgId}, ${name}, ${type}, ${type === 'glob' ? 'review/*' : null})
      RETURNING id`.execute(db);
    return r.rows[0]!.id;
  };

  const insertRun = async (runId: string, environment: string): Promise<void> => {
    await sql`
      INSERT INTO public.execution_runs
        (run_id, workflow_name, provider, repo_identifier, ref, sha, environment)
      VALUES (${runId}, 'wf', 'github', 'owner/repo', 'refs/heads/main', 'abc', ${environment})
    `.execute(db);
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

  it('adds a nullable environment_id column with an FK to environments', async () => {
    const col = await column('execution_runs', 'environment_id');
    expect(col?.data_type).toBe('uuid');
    expect(col?.is_nullable).toBe('YES');
    expect(await fkTarget()).toBe('environments');
  });

  it('backfills environment_id for rows whose environment matches a unique fixed env', async () => {
    const e1 = await insertEnv('org_aaaaaaaa', 'production', 'fixed');
    await insertRun('11111111-1111-1111-1111-111111111111', 'production');
    // The new column already exists (migrateToLatest ran up once on empty data),
    // so up() now only re-runs the idempotent backfill over the seeded rows.
    await up(db);
    expect(await envId('11111111-1111-1111-1111-111111111111')).toBe(e1);
  });

  it('leaves environment_id null for glob-named and ambiguous-name rows', async () => {
    // Glob env: its label 'Review apps' never equals the concrete run name.
    await insertEnv('org_bbbbbbbb', 'Review apps', 'glob');
    await insertRun('22222222-2222-2222-2222-222222222222', 'review/PR-1');
    // Ambiguous fixed name: two fixed envs named 'staging' in different orgs.
    await insertEnv('org_cccccccc', 'staging', 'fixed');
    await insertEnv('org_dddddddd', 'staging', 'fixed');
    await insertRun('33333333-3333-3333-3333-333333333333', 'staging');

    await up(db);

    expect(await envId('22222222-2222-2222-2222-222222222222')).toBeNull();
    expect(await envId('33333333-3333-3333-3333-333333333333')).toBeNull();
  });
});
