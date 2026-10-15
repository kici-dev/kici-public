import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { type Kysely, sql } from 'kysely';
import { HoldScope, HoldType, installGateJobId, TriggerSource } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import { HeldRunStore } from './held-runs.js';
import type { Database } from '../db/types.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres integration test for the workflow install-hold release helper
 * `releaseDueWaitHolds`. Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<Database>(
  'HeldRunStore release helpers',
  { prefix: 'kici_heldrel_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;
    let store: HeldRunStore;

    const seedHold = async (overrides: {
      runId: string;
      holdType: string;
      envId: string;
      expiresAt: Date;
      createdAt?: Date;
    }): Promise<string> => {
      const row = await store.createHold('org-1', {
        runId: overrides.runId,
        jobId: installGateJobId(String(overrides.runId)),
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

    beforeAll(() => {
      ({ db } = getDb());
      store = new HeldRunStore(db);
    });

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
      const secondOverdueRun = randomUUID();
      const futureRun = randomUUID();
      const reviewerRun = randomUUID();
      // What the install gate writes today.
      const overdueId = await seedHold({
        runId: overdueRun,
        holdType: HoldType.enum.timer,
        envId: envId1,
        expiresAt: new Date(Date.now() - 60_000),
      });
      // A second overdue hold: the sweep releases every due row, not just one.
      const secondOverdueId = await seedHold({
        runId: secondOverdueRun,
        holdType: HoldType.enum.timer,
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
      expect(released.map((r) => r.holdId).sort()).toEqual([overdueId, secondOverdueId].sort());
      for (const signal of released) {
        expect(signal.scope).toBe(HoldScope.enum.workflow);
      }
      expect(released.map((r) => r.runId).sort()).toEqual([overdueRun, secondOverdueRun].sort());

      const stillPending = await db
        .selectFrom('held_runs')
        .select(['run_id', 'status'])
        .where('status', '=', 'pending')
        .execute();
      const pendingRuns = stillPending.map((r) => r.run_id).sort();
      expect(pendingRuns).toEqual([futureRun, reviewerRun].sort());
    });
  },
);
