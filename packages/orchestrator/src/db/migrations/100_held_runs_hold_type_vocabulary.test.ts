import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { HoldType } from '@kici-dev/engine';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './100_held_runs_hold_type_vocabulary.js';

/**
 * Real-Postgres test for migration 100: asserts the legacy `approval` /
 * `wait_timer` spellings in `held_runs.hold_type` are backfilled onto the
 * engine `HoldType` vocabulary, that already-current rows are untouched, and
 * that `up` is idempotent. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig100_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 100_held_runs_hold_type_vocabulary', () => {
  let db: Kysely<unknown>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  /** Insert a pending held run carrying `holdType` in the column. */
  const insertHeldRun = async (holdType: string): Promise<void> => {
    await sql`
      INSERT INTO public.held_runs (org_id, run_id, job_id, context_id, hold_type, expires_at)
      VALUES ('org-mig100', gen_random_uuid(), 'job-1', NULL, ${holdType}, now() + interval '1 hour')
    `.execute(db);
  };

  /** Every `hold_type` currently stored, sorted. */
  const holdTypes = async (): Promise<string[]> => {
    const r = await sql<{ hold_type: string }>`
      SELECT hold_type FROM public.held_runs ORDER BY hold_type
    `.execute(db);
    return r.rows.map((row) => row.hold_type);
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

  beforeEach(async () => {
    await sql`DELETE FROM public.held_runs`.execute(db);
  });

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

  it('backfills the legacy spellings', async () => {
    await insertHeldRun('approval');
    await insertHeldRun('wait_timer');

    await up(db);

    expect(await holdTypes()).toEqual([HoldType.enum.reviewer, HoldType.enum.timer]);
  });

  it('leaves already-current rows alone', async () => {
    await insertHeldRun(HoldType.enum.concurrency);
    await insertHeldRun(HoldType.enum.security);

    await up(db);

    expect(await holdTypes()).toEqual([HoldType.enum.concurrency, HoldType.enum.security]);
  });

  it('leaves an unknown hold type untouched', async () => {
    // A newer orchestrator's hold type must survive an older reader's
    // migration run rather than being coerced onto a known member.
    await insertHeldRun('some_future_type');

    await up(db);

    expect(await holdTypes()).toEqual(['some_future_type']);
  });

  it('is idempotent', async () => {
    // Deploys re-run migrations; a second up() must be a no-op, not a further
    // rewrite.
    await insertHeldRun('approval');

    await up(db);
    await up(db);

    expect(await holdTypes()).toEqual([HoldType.enum.reviewer]);
  });

  it('down() restores the legacy spellings', async () => {
    await insertHeldRun('approval');
    await insertHeldRun('wait_timer');
    await up(db);

    await down(db);

    expect(await holdTypes()).toEqual(['approval', 'wait_timer']);
  });
});
