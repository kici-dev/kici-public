import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './123_workflow_registrations_default_branch.js';

/**
 * Real-Postgres test for migration 123: asserts
 * `workflow_registrations.default_branch` exists as a NULLABLE text column
 * after migrations 001..123, that a row written BEFORE the column existed reads
 * NULL rather than a fabricated branch, and that up/down are idempotent. Gated
 * on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig123_test_${process.pid}_${Date.now()}`;

const COLUMN = 'default_branch';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 123_workflow_registrations_default_branch', () => {
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

  const seedRegistration = async (workflowName: string): Promise<void> => {
    await sql`
      INSERT INTO public.workflow_registrations
        (repo_identifier, workflow_name, lock_entry, trigger_types, customer_id)
      VALUES ('owner/repo', ${workflowName}, '{}'::jsonb, ARRAY['schedule'], 'org-1')
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
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  it('adds the column as a nullable text column', async () => {
    const state = await columnState('workflow_registrations', COLUMN);
    expect(state.exists).toBe(true);
    expect(state.dataType).toBe('text');
    expect(state.nullable).toBe(true);
  });

  it('leaves a row that predates the column NULL, never a fabricated branch', async () => {
    // The load-bearing assertion. There is no backfill: the default branch is
    // only knowable from a webhook payload, so a registration written before
    // this migration has no branch until its repo's next default-branch push
    // re-registers it. NULL is what the dispatch path reads as "no branch",
    // which keeps the honest branch-gate rejection. A DEFAULT would invent a
    // branch the registration never proved.
    await down(db);
    expect((await columnState('workflow_registrations', COLUMN)).exists).toBe(false);
    await seedRegistration('pre-migration-workflow');
    await up(db);

    const r = await sql<{ default_branch: string | null }>`
      SELECT default_branch FROM public.workflow_registrations
       WHERE workflow_name = 'pre-migration-workflow'
    `.execute(db);
    expect(r.rows[0]?.default_branch).toBeNull();
  });

  it('defaults a freshly inserted row to NULL', async () => {
    await seedRegistration('post-migration-workflow');
    const r = await sql<{ default_branch: string | null }>`
      SELECT default_branch FROM public.workflow_registrations
       WHERE workflow_name = 'post-migration-workflow'
    `.execute(db);
    expect(r.rows[0]?.default_branch).toBeNull();
  });

  it('down() drops it and up() restores it, idempotently', async () => {
    await down(db);
    expect((await columnState('workflow_registrations', COLUMN)).exists).toBe(false);

    await up(db);
    await up(db); // idempotent
    expect((await columnState('workflow_registrations', COLUMN)).exists).toBe(true);
  });
});
