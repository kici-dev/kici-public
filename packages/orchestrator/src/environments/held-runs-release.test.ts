import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { HoldScope, TriggerSource } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import { HeldRunStore } from './held-runs.js';
import type { Database } from '../db/types.js';

/**
 * Real-Postgres integration test for the workflow install-hold release helpers
 * (releaseDueWaitHolds + releaseConcurrencyHold). Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_heldrel_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describeDb('HeldRunStore release helpers', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  let store: HeldRunStore;
  const adminUrl = ADMIN_URL!;

  const seedHold = async (overrides: {
    runId: string;
    holdType: string;
    envId: string;
    expiresAt: Date;
    createdAt?: Date;
  }): Promise<string> => {
    const row = await store.createHold('org-1', {
      runId: overrides.runId,
      jobId: `__install__${overrides.runId}`,
      scope: HoldScope.enum.workflow,
      triggerSource: TriggerSource.enum.environment,
      environmentId: overrides.envId,
      holdType: overrides.holdType,
      requirement: {
        clauses: [],
        expiresAt: overrides.expiresAt.toISOString(),
        reason: 'install gate',
      },
    });
    if (overrides.createdAt) {
      await sql`UPDATE held_runs SET created_at = ${overrides.createdAt} WHERE id = ${row.id}`.execute(
        db,
      );
    }
    return row.id;
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
    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
    store = new HeldRunStore(db);
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

  // Real environment uuids (FK target of held_runs.environment_id).
  let envId1 = '';
  let envIdC = '';
  let envIdA = '';

  const insertEnv = async (name: string): Promise<string> => {
    const row = await sql<{ id: string }>`
      INSERT INTO public.environments (org_id, name, type)
      VALUES ('org-1', ${name}, 'fixed')
      RETURNING id
    `.execute(db);
    return row.rows[0]!.id;
  };

  beforeEach(async () => {
    await sql`DELETE FROM held_runs`.execute(db);
    await sql`DELETE FROM environments`.execute(db);
    envId1 = await insertEnv('env-1');
    envIdC = await insertEnv('env-c');
    envIdA = await insertEnv('env-a');
  });

  it('releaseDueWaitHolds releases only overdue wait_timer workflow holds', async () => {
    const overdueRun = randomUUID();
    const futureRun = randomUUID();
    const reviewerRun = randomUUID();
    const overdueId = await seedHold({
      runId: overdueRun,
      holdType: 'wait_timer',
      envId: envId1,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await seedHold({
      runId: futureRun,
      holdType: 'wait_timer',
      envId: envId1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // A reviewer hold past expiry must NOT be released by the wait sweep.
    await seedHold({
      runId: reviewerRun,
      holdType: 'reviewer',
      envId: envId1,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const released = await store.releaseDueWaitHolds();
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({
      holdId: overdueId,
      runId: overdueRun,
      scope: 'workflow',
    });

    const stillPending = await db
      .selectFrom('held_runs')
      .select(['run_id', 'status'])
      .where('status', '=', 'pending')
      .execute();
    const pendingRuns = stillPending.map((r) => r.run_id).sort();
    expect(pendingRuns).toEqual([futureRun, reviewerRun].sort());
  });

  it('releaseConcurrencyHold releases the oldest queued concurrency hold for the env', async () => {
    const oldRun = randomUUID();
    const newRun = randomUUID();
    const oldestId = await seedHold({
      runId: oldRun,
      holdType: 'concurrency',
      envId: envIdC,
      expiresAt: new Date(Date.now() + 600_000),
      createdAt: new Date(Date.now() - 120_000),
    });
    await seedHold({
      runId: newRun,
      holdType: 'concurrency',
      envId: envIdC,
      expiresAt: new Date(Date.now() + 600_000),
      createdAt: new Date(Date.now() - 60_000),
    });

    const released = await store.releaseConcurrencyHold('org-1', envIdC);
    expect(released?.holdId).toBe(oldestId);
    expect(released?.runId).toBe(oldRun);

    // A second call releases the next-oldest; a third returns null.
    const second = await store.releaseConcurrencyHold('org-1', envIdC);
    expect(second?.runId).toBe(newRun);
    expect(await store.releaseConcurrencyHold('org-1', envIdC)).toBeNull();
  });

  it('releaseConcurrencyHold returns null for a different env group', async () => {
    await seedHold({
      runId: randomUUID(),
      holdType: 'concurrency',
      envId: envIdA,
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect(await store.releaseConcurrencyHold('org-1', randomUUID())).toBeNull();
  });
});
