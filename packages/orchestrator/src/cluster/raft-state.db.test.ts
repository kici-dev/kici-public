import { beforeAll, beforeEach, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { RaftStateStore } from './raft-state.js';

/**
 * Real-Postgres coverage for the save a leaving coordinator makes: the cluster
 * shares one raft_state row, so that save must not overwrite a newer term the
 * remaining coordinators wrote after it announced it was leaving.
 */
describeWithTestDb<Database>(
  'RaftStateStore against Postgres',
  { prefix: 'kici_raft_state_test', provider: createMigrationProvider() },
  (getDb) => {
    let db: Kysely<Database>;

    beforeAll(() => {
      ({ db } = getDb());
    });

    beforeEach(async () => {
      await db.deleteFrom('raft_state').execute();
    });

    // fails-when: the leaving node's save overwrites the term and leader the
    // remaining coordinators elected after it announced it was leaving.
    it('keeps a newer term when a leaving node saves an older one', async () => {
      const store = new RaftStateStore({ db });
      await store.save({ currentTerm: 6, votedFor: 'orch-b', leaderId: 'orch-b' });

      await store.saveUnlessNewerTerm({ currentTerm: 5, votedFor: 'orch-a', leaderId: null });

      expect(await store.load()).toEqual({
        currentTerm: 6,
        votedFor: 'orch-b',
        leaderId: 'orch-b',
      });
    });

    // breaks-if-wrong: the last coordinator to leave still records its state.
    it('writes when the stored term is not newer', async () => {
      const store = new RaftStateStore({ db });
      await store.save({ currentTerm: 5, votedFor: 'orch-a', leaderId: 'orch-a' });

      await store.saveUnlessNewerTerm({ currentTerm: 5, votedFor: 'orch-a', leaderId: null });

      expect(await store.load()).toEqual({ currentTerm: 5, votedFor: 'orch-a', leaderId: null });
    });

    // breaks-if-wrong: a cluster with no row yet gets one.
    it('inserts the row when none exists', async () => {
      const store = new RaftStateStore({ db });

      await store.saveUnlessNewerTerm({ currentTerm: 2, votedFor: null, leaderId: null });

      expect(await store.load()).toEqual({ currentTerm: 2, votedFor: null, leaderId: null });
    });
  },
);
