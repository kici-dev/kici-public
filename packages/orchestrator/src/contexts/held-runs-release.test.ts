import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { HoldScope, HoldType, TriggerSource } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import { HeldRunStore } from './held-runs.js';
import type { Database } from '../db/types.js';

/**
 * Real-Postgres integration test for the workflow install-hold release helper
 * `releaseDueWaitHolds`. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
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
      triggerSource: TriggerSource.enum.context,
      contextId: overrides.envId,
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

  // Real context uuids (FK target of held_runs.context_id).
  let envId1 = '';

  const insertEnv = async (name: string): Promise<string> => {
    const row = await sql<{ id: string }>`
      INSERT INTO public.contexts (org_id, name, type)
      VALUES ('org-1', ${name}, 'fixed')
      RETURNING id
    `.execute(db);
    return row.rows[0]!.id;
  };

  beforeEach(async () => {
    await sql`DELETE FROM held_runs`.execute(db);
    await sql`DELETE FROM contexts`.execute(db);
    envId1 = await insertEnv('env-1');
  });

  it('releaseDueWaitHolds releases only overdue timer workflow holds', async () => {
    const overdueRun = randomUUID();
    const legacyOverdueRun = randomUUID();
    const futureRun = randomUUID();
    const reviewerRun = randomUUID();
    // What the install gate writes today.
    const overdueId = await seedHold({
      runId: overdueRun,
      holdType: HoldType.enum.timer,
      envId: envId1,
      expiresAt: new Date(Date.now() - 60_000),
    });
    // A row an un-upgraded orchestrator wrote before the backfill. It must
    // resume too — otherwise it falls through to `expireOverdue()` and the
    // workflow fails instead of continuing.
    const legacyOverdueId = await seedHold({
      runId: legacyOverdueRun,
      holdType: 'wait_timer',
      envId: envId1,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await seedHold({
      runId: futureRun,
      holdType: HoldType.enum.timer,
      envId: envId1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    // A reviewer hold past expiry must NOT be released by the wait sweep.
    await seedHold({
      runId: reviewerRun,
      holdType: HoldType.enum.reviewer,
      envId: envId1,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const released = await store.releaseDueWaitHolds();
    expect(released).toHaveLength(2);
    expect(released.map((r) => r.holdId).sort()).toEqual([overdueId, legacyOverdueId].sort());
    for (const signal of released) {
      expect(signal.scope).toBe(HoldScope.enum.workflow);
    }
    expect(released.map((r) => r.runId).sort()).toEqual([overdueRun, legacyOverdueRun].sort());

    const stillPending = await db
      .selectFrom('held_runs')
      .select(['run_id', 'status'])
      .where('status', '=', 'pending')
      .execute();
    const pendingRuns = stillPending.map((r) => r.run_id).sort();
    expect(pendingRuns).toEqual([futureRun, reviewerRun].sort());
  });
});
