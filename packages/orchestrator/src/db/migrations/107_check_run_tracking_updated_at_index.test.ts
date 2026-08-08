import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { migrateToOwnMigration } from '../migration-test-harness.js';
import { down, up } from './107_check_run_tracking_updated_at_index.js';
import type { Database } from '../types.js';
import { CheckRunTrackingStore } from '../../reporting/check-run-tracking-store.js';

/**
 * Real-Postgres test for migration 107. Creates a throwaway database, applies
 * migrations 001..107, and asserts `idx_check_run_tracking_updated_at` exists
 * after up() and is gone after down() (then recreated idempotently). A second
 * block runs `CheckRunTrackingStore.pruneStale` against real Postgres: the
 * mock-DB unit tests assert which builder methods were called, so only this
 * one proves the `make_interval(days => $1)` predicate actually executes and
 * deletes exactly the stale rows. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_mig107_test_${process.pid}_${Date.now()}`;
const INDEX = 'idx_check_run_tracking_updated_at';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('migration 107_check_run_tracking_updated_at_index', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  const indexExists = async (): Promise<boolean> => {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ${INDEX}
      ) AS exists
    `.execute(db);
    return Boolean(result.rows[0]?.exists);
  };

  /**
   * Insert a row with an explicit `updated_at`. `run_id` is left NULL on
   * purpose for one of them: a row born at check-run create with no run
   * attribution is precisely the shape the sweep has to be able to reclaim.
   */
  const insertRow = async (
    checkName: string,
    updatedAt: Date,
    runId: string | null,
  ): Promise<void> => {
    await db
      .insertInto('check_run_tracking')
      .values({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        check_name: checkName,
        check_run_id: 1,
        run_id: runId,
        updated_at: updatedAt,
      })
      .execute();
  };

  const remainingCheckNames = async (): Promise<string[]> => {
    const rows = await db.selectFrom('check_run_tracking').select(['check_name']).execute();
    return rows.map((r) => r.check_name).sort();
  };

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
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

  it('creates idx_check_run_tracking_updated_at (the beforeAll migration ran it)', async () => {
    expect(await indexExists()).toBe(true);
  });

  it('down() drops the index; up() recreates it idempotently', async () => {
    await down(db as unknown as Kysely<unknown>);
    expect(await indexExists()).toBe(false);
    await up(db as unknown as Kysely<unknown>);
    await up(db as unknown as Kysely<unknown>); // idempotent (IF NOT EXISTS)
    expect(await indexExists()).toBe(true);
  });

  it('pruneStale deletes only rows past the window, run_id or not', async () => {
    await db.deleteFrom('check_run_tracking').execute();
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 86_400_000);
    await insertRow('kici/old-with-run', daysAgo(40), 'run-old');
    await insertRow('kici/old-no-run', daysAgo(40), null);
    await insertRow('kici/fresh-with-run', daysAgo(1), 'run-fresh');
    await insertRow('kici/fresh-no-run', daysAgo(1), null);

    const store = new CheckRunTrackingStore(db);
    expect(await store.pruneStale(7)).toBe(2);
    expect(await remainingCheckNames()).toEqual(['kici/fresh-no-run', 'kici/fresh-with-run']);
  });

  it('pruneStale is a no-op when retentionDays <= 0', async () => {
    await db.deleteFrom('check_run_tracking').execute();
    await insertRow('kici/ancient', new Date(Date.now() - 999 * 86_400_000), null);

    const store = new CheckRunTrackingStore(db);
    expect(await store.pruneStale(0)).toBe(0);
    expect(await store.pruneStale(-1)).toBe(0);
    expect(await remainingCheckNames()).toEqual(['kici/ancient']);
  });

  it('an upsert bumps updated_at, so a touched row survives the next sweep', async () => {
    await db.deleteFrom('check_run_tracking').execute();
    await insertRow('kici/build', new Date(Date.now() - 40 * 86_400_000), 'run-a');

    // The write path the reporter uses. Without the refresh this row is 40
    // days stale and the sweep below would take it.
    const store = new CheckRunTrackingStore(db);
    await store.setCheckRunId(
      {
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        checkName: 'kici/build',
      },
      4242,
      'run-a',
    );

    expect(await store.pruneStale(7)).toBe(0);
    expect(await remainingCheckNames()).toEqual(['kici/build']);
  });
});
