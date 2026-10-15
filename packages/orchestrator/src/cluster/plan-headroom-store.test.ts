import { beforeAll, expect, it } from 'vitest';
import { createMigrationProvider } from '../db/migration-provider.js';
import { PlanHeadroomStore } from './plan-headroom-store.js';
import type { Database } from '../db/types.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

/**
 * Real-Postgres test for PlanHeadroomStore. The store's whole reason to exist is
 * that the ceiling SURVIVES a restart, which a mocked query builder cannot show.
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
describeWithTestDb<Database>(
  'PlanHeadroomStore',
  { prefix: 'kici_planheadroom_test', provider: createMigrationProvider(), timeoutMs: 120_000 },
  (getDb) => {
    let store: PlanHeadroomStore;

    beforeAll(() => {
      store = new PlanHeadroomStore(getDb().db);
    });

    it('round-trips a pushed ceiling', async () => {
      expect(await store.read()).toBeNull();

      await store.write({
        type: 'plan.headroom',
        maxWorkerPeers: 3,
        orgLimit: 5,
        orgTotal: 2,
        evictExcess: false,
      });

      const stored = await store.read();
      expect(stored?.maxWorkerPeers).toBe(3);
      expect(stored?.evictExcess).toBe(false);
    });

    it('overwrites the single row rather than accumulating', async () => {
      await store.write({
        type: 'plan.headroom',
        maxWorkerPeers: 3,
        orgLimit: 5,
        orgTotal: 2,
        evictExcess: false,
      });
      await store.write({
        type: 'plan.headroom',
        maxWorkerPeers: 0,
        orgLimit: 5,
        orgTotal: 6,
        evictExcess: true,
      });
      expect((await store.read())?.maxWorkerPeers).toBe(0);
      expect((await store.read())?.evictExcess).toBe(true);
    });
  },
);
