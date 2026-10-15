import { beforeAll, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { createMigrationProvider } from '../db/migration-provider.js';
import {
  appendBatchItem,
  openOrGetBatchWindow,
  sweepExpiredBatchWindows,
} from './batch-accumulator.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for the batch accumulator. Gated on
 * `KICI_TEST_ADMIN_DATABASE_URL` (creates a throwaway database).
 */
describeWithTestDb<Database>(
  'batch-accumulator',
  { prefix: 'kici_batchacc_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

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
  },
);
