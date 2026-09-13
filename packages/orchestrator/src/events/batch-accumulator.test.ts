import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import type { Database } from '../db/types.js';
import { createMigrationProvider } from '../db/migration-provider.js';
import {
  appendBatchItem,
  openOrGetBatchWindow,
  sweepExpiredBatchWindows,
} from './batch-accumulator.js';

/**
 * Real-Postgres test for the batch accumulator. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL` (creates a throwaway database).
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_batchacc_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('batch-accumulator', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db: db as unknown as Kysely<unknown>,
      provider: createMigrationProvider(),
    }).migrateToLatest();
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

  const openInput = (registrationId: string, accumulateForMs: number) => ({
    registrationId,
    customerId: 'cust',
    routingKey: 'github:1',
    repoIdentifier: 'org/repo',
    accumulateForMs,
  });

  it('opens once, appends, and sweeps the accumulated runs', async () => {
    const first = await openOrGetBatchWindow(db, openInput('reg-open', 10_000));
    expect(first.opened).toBe(true);

    const second = await openOrGetBatchWindow(db, openInput('reg-open', 10_000));
    expect(second.opened).toBe(false);
    expect(second.windowId).toBe(first.windowId);

    for (let i = 0; i < 3; i++) {
      await appendBatchItem(db, {
        windowId: first.windowId,
        run: { runId: `run-${i}`, repoIdentifier: 'org/repo', workflowName: 'CI' },
      });
    }

    // Not yet expired -> not swept.
    const notYet = await sweepExpiredBatchWindows(db, new Date(Date.now() - 60_000));
    expect(notYet).toHaveLength(0);

    // Past the deadline -> swept with the 3 runs; window cleared.
    const swept = await sweepExpiredBatchWindows(db, new Date(Date.now() + 60_000));
    const mine = swept.find((w) => w.registrationId === 'reg-open');
    expect(mine).toBeDefined();
    expect(mine!.runs).toHaveLength(3);
    expect(mine!.runs.map((r) => r.runId).sort()).toEqual(['run-0', 'run-1', 'run-2']);

    // Window is gone -> a new open() opens fresh.
    const reopened = await openOrGetBatchWindow(db, openInput('reg-open', 10_000));
    expect(reopened.opened).toBe(true);
  });

  it('sweeps an empty window (all runs excluded) with zero runs', async () => {
    await openOrGetBatchWindow(db, openInput('reg-empty', 1));
    const swept = await sweepExpiredBatchWindows(db, new Date(Date.now() + 60_000));
    const mine = swept.find((w) => w.registrationId === 'reg-empty');
    expect(mine).toBeDefined();
    expect(mine!.runs).toHaveLength(0);
  });
});
