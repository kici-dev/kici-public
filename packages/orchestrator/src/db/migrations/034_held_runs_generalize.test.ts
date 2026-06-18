import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../migration-provider.js';
import * as m034 from './034_held_runs_generalize.js';

/**
 * Real-Postgres test for migration 034.
 *
 * Creates a throwaway database, runs every migration up to 034 via the
 * production provider, and asserts the generalized held_runs columns + the
 * held_run_approvals table (with its FK to held_runs). Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig034_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 034_held_runs_generalize', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;

  const heldRunCol = async (name: string): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'held_runs'
           AND column_name = ${name}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  const tableExists = async (name: string): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${name}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  const approvalCol = async (name: string): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'held_run_approvals'
           AND column_name = ${name}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists ?? false;
  };

  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }

    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
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

  it('adds hold_scope, step_index, trigger_source, approval_requirement to held_runs', async () => {
    expect(await heldRunCol('hold_scope')).toBe(true);
    expect(await heldRunCol('step_index')).toBe(true);
    expect(await heldRunCol('trigger_source')).toBe(true);
    expect(await heldRunCol('approval_requirement')).toBe(true);
  });

  it('creates held_run_approvals with the expected columns', async () => {
    expect(await tableExists('held_run_approvals')).toBe(true);
    for (const col of [
      'id',
      'held_run_id',
      'approver_user_id',
      'decision',
      'clauses_satisfied',
      'created_at',
    ]) {
      expect(await approvalCol(col)).toBe(true);
    }
  });

  it('held_run_approvals cascades on held_runs delete', async () => {
    // Insert a held_runs row, then an approval row, then delete the parent and
    // assert the child is gone (FK ON DELETE CASCADE).
    const held = await sql<{ id: string }>`
      INSERT INTO public.held_runs (org_id, run_id, job_id, environment_id, hold_type, expires_at)
      VALUES ('oal_cascadetst1', gen_random_uuid(), 'job-a', NULL, 'approval', now() + interval '1 day')
      RETURNING id
    `.execute(db);
    const heldId = held.rows[0]!.id;
    await sql`
      INSERT INTO public.held_run_approvals (held_run_id, approver_user_id, decision)
      VALUES (${heldId}, 'u-alice', 'approve')
    `.execute(db);
    await sql`DELETE FROM public.held_runs WHERE id = ${heldId}`.execute(db);
    const remaining = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM public.held_run_approvals WHERE held_run_id = ${heldId}
    `.execute(db);
    expect(remaining.rows[0]!.count).toBe('0');
  });

  it('up() is idempotent and down() drops the additions', async () => {
    await m034.up(db);
    expect(await heldRunCol('hold_scope')).toBe(true);

    await m034.down(db);
    expect(await tableExists('held_run_approvals')).toBe(false);
    expect(await heldRunCol('hold_scope')).toBe(false);
    expect(await heldRunCol('approval_requirement')).toBe(false);

    // down() is itself idempotent; up() restores everything.
    await m034.down(db);
    await m034.up(db);
    expect(await heldRunCol('hold_scope')).toBe(true);
    expect(await tableExists('held_run_approvals')).toBe(true);
  });
});
