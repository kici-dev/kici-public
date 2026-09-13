import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaftStateStore } from './raft-state.js';

// ── Mock helpers ──────────────────────────────────────────────────

/**
 * Create a mock Kysely DB that supports the raft_state query patterns.
 * Uses a self-referencing chain object for flexible query building.
 *
 * NOTE: This test uses a specialized mock (single chain object with value
 * capture) instead of the shared createMockDb() from
 * '../__test-helpers__/mock-db.js' because RaftStateStore tests capture
 * the actual values passed to .values() and .doUpdateSet() for assertions.
 */
function createMockDb(rows: any[] = []) {
  let lastInsertValues: any = null;
  let lastConflictUpdateValues: any = null;

  const chain: any = {};
  for (const method of [
    'selectFrom',
    'select',
    'where',
    'executeTakeFirst',
    'insertInto',
    'values',
    'onConflict',
    'column',
    'doUpdateSet',
    'execute',
  ]) {
    chain[method] = vi.fn((...args: any[]) => {
      if (method === 'values') lastInsertValues = args[0];
      if (method === 'doUpdateSet') lastConflictUpdateValues = args[0];
      if (method === 'executeTakeFirst') return Promise.resolve(rows[0] ?? undefined);
      if (method === 'execute') return Promise.resolve(rows);
      if (method === 'onConflict') {
        // onConflict takes a callback that receives the conflict builder
        const cb = args[0];
        if (typeof cb === 'function') {
          cb(chain);
        }
        return chain;
      }
      return chain;
    });
  }

  return {
    db: chain,
    getLastInsertValues: () => lastInsertValues,
    getLastConflictUpdateValues: () => lastConflictUpdateValues,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('RaftStateStore', () => {
  let store: RaftStateStore;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    store = new RaftStateStore({ db: mockDb.db });
  });

  describe('load', () => {
    it('should return defaults when no row exists', async () => {
      const state = await store.load();

      expect(state).toEqual({
        currentTerm: 0,
        votedFor: null,
        leaderId: null,
      });

      expect(mockDb.db.selectFrom).toHaveBeenCalledWith('raft_state');
      expect(mockDb.db.where).toHaveBeenCalledWith('cluster_id', '=', 'default');
    });

    it('should return persisted state when row exists', async () => {
      const dbWithRow = createMockDb([
        {
          current_term: 5,
          voted_for: 'orch-2',
          leader_id: 'orch-1',
        },
      ]);
      const storeWithData = new RaftStateStore({ db: dbWithRow.db });

      const state = await storeWithData.load();

      expect(state).toEqual({
        currentTerm: 5,
        votedFor: 'orch-2',
        leaderId: 'orch-1',
      });
    });

    it('should use custom clusterId', async () => {
      const customStore = new RaftStateStore({ db: mockDb.db, clusterId: 'my-cluster' });
      await customStore.load();

      expect(mockDb.db.where).toHaveBeenCalledWith('cluster_id', '=', 'my-cluster');
    });
  });

  describe('save', () => {
    it('should upsert full state', async () => {
      await store.save({
        currentTerm: 3,
        votedFor: 'orch-1',
        leaderId: 'orch-2',
      });

      expect(mockDb.db.insertInto).toHaveBeenCalledWith('raft_state');
      expect(mockDb.db.values).toHaveBeenCalledWith({
        cluster_id: 'default',
        current_term: 3,
        voted_for: 'orch-1',
        leader_id: 'orch-2',
      });
      expect(mockDb.db.onConflict).toHaveBeenCalled();
    });

    it('should handle null values', async () => {
      await store.save({
        currentTerm: 0,
        votedFor: null,
        leaderId: null,
      });

      expect(mockDb.db.values).toHaveBeenCalledWith({
        cluster_id: 'default',
        current_term: 0,
        voted_for: null,
        leader_id: null,
      });
    });
  });

  describe('updateLeader', () => {
    it('should upsert leader and term', async () => {
      await store.updateLeader('orch-3', 7);

      expect(mockDb.db.insertInto).toHaveBeenCalledWith('raft_state');
      expect(mockDb.db.values).toHaveBeenCalledWith({
        cluster_id: 'default',
        current_term: 7,
        voted_for: null,
        leader_id: 'orch-3',
      });
      expect(mockDb.db.onConflict).toHaveBeenCalled();
    });
  });
});
