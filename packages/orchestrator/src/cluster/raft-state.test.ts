import { describe, it, expect, beforeEach } from 'vitest';
import { RaftStateStore } from './raft-state.js';
import { createMockDb, type MockDb } from '../__test-helpers__/mock-db.js';

describe('RaftStateStore', () => {
  let store: RaftStateStore;
  let mockDb: MockDb;

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

      expect(mockDb.mocks.selectFrom).toHaveBeenCalledWith('raft_state');
      expect(mockDb.mocks.selectWhere).toHaveBeenCalledWith('cluster_id', '=', 'default');
    });

    it('should return persisted state when row exists', async () => {
      const dbWithRow = createMockDb({
        selectFirstRow: {
          current_term: 5,
          voted_for: 'orch-2',
          leader_id: 'orch-1',
        },
      });
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

      expect(mockDb.mocks.selectWhere).toHaveBeenCalledWith('cluster_id', '=', 'my-cluster');
    });
  });

  describe('save', () => {
    it('should upsert full state', async () => {
      await store.save({
        currentTerm: 3,
        votedFor: 'orch-1',
        leaderId: 'orch-2',
      });

      expect(mockDb.mocks.insertInto).toHaveBeenCalledWith('raft_state');
      expect(mockDb.mocks.insertValues).toHaveBeenCalledWith({
        cluster_id: 'default',
        current_term: 3,
        voted_for: 'orch-1',
        leader_id: 'orch-2',
      });
      expect(mockDb.mocks.onConflict).toHaveBeenCalled();
    });

    it('should handle null values', async () => {
      await store.save({
        currentTerm: 0,
        votedFor: null,
        leaderId: null,
      });

      expect(mockDb.mocks.insertValues).toHaveBeenCalledWith({
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

      expect(mockDb.mocks.insertInto).toHaveBeenCalledWith('raft_state');
      expect(mockDb.mocks.insertValues).toHaveBeenCalledWith({
        cluster_id: 'default',
        current_term: 7,
        voted_for: null,
        leader_id: 'orch-3',
      });
      expect(mockDb.mocks.onConflict).toHaveBeenCalled();
    });
  });
});
