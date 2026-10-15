import { beforeAll, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { DedupCache } from './dedup.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';

// Real-Postgres cluster-correctness test for the atomic dedup claim. Gated on
// KICI_TEST_ADMIN_DATABASE_URL — the mock-based coverage lives in dedup.test.ts;
// this file proves the ON CONFLICT arbiter against a real unique constraint so
// two concurrent claims on the same delivery yield exactly one winner.
describeWithTestDb<Database>(
  'DedupCache.claim — atomic cluster-wide claim (real Postgres)',
  { prefix: 'kici_dedup_claim_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

    it('first claim wins, second claim on the same id is a duplicate', async () => {
      const cache = new DedupCache(db);
      expect(await cache.claim('delivery-1')).toBe(true);
      expect(await cache.claim('delivery-1')).toBe(false);
    });

    it('two simulated instances (separate caches, shared DB) — exactly one wins the race', async () => {
      // Each DedupCache has its own in-memory set, modelling two orchestrator
      // instances behind an LB that both receive the same X-GitHub-Delivery.
      const instanceA = new DedupCache(db);
      const instanceB = new DedupCache(db);
      const [a, b] = await Promise.all([instanceA.claim('race-1'), instanceB.claim('race-1')]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
    });

    it('distinct delivery ids both win', async () => {
      const cache = new DedupCache(db);
      expect(await cache.claim('k-a')).toBe(true);
      expect(await cache.claim('k-b')).toBe(true);
    });
  },
);
