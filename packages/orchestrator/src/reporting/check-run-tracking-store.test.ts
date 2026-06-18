import { describe, it, expect } from 'vitest';

import {
  CheckRunTrackingStore,
  rowToState,
  type CheckRunTrackingKey,
} from './check-run-tracking-store.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

const KEY: CheckRunTrackingKey = {
  provider: 'github',
  owner: 'myorg',
  repo: 'myrepo',
  sha: 'abc123',
  checkName: 'kici/build/job/test',
};

describe('CheckRunTrackingStore', () => {
  describe('setCheckRunId', () => {
    it('upserts the check-run ID via insertInto with onConflict', async () => {
      const { db, mocks } = createMockDb();
      const store = new CheckRunTrackingStore(db);

      await store.setCheckRunId(KEY, 12345);

      expect(mocks.insertInto).toHaveBeenCalledWith('check_run_tracking');
      expect(mocks.onConflict).toHaveBeenCalled();
    });
  });

  describe('getCheckRunId', () => {
    it('returns undefined when no row exists', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new CheckRunTrackingStore(db);

      const result = await store.getCheckRunId(KEY);

      expect(result).toBeUndefined();
    });

    it('returns the numeric check_run_id when row exists', async () => {
      const { db } = createMockDb({
        selectFirstRow: {
          check_run_id: 12345,
          build_creation_state: null,
          step_progress_json: null,
          in_progress_sent_at: null,
          run_id: null,
          updated_at: new Date(),
        },
      });
      const store = new CheckRunTrackingStore(db);

      const result = await store.getCheckRunId(KEY);

      expect(result).toBe(12345);
    });

    it('coerces a BIGINT-as-string value to a number', async () => {
      const { db } = createMockDb({
        selectFirstRow: {
          check_run_id: '12345',
          build_creation_state: null,
          step_progress_json: null,
          in_progress_sent_at: null,
          run_id: null,
          updated_at: new Date(),
        },
      });
      const store = new CheckRunTrackingStore(db);

      const result = await store.getCheckRunId(KEY);

      expect(result).toBe(12345);
    });

    it('returns undefined when row exists but check_run_id is null', async () => {
      const { db } = createMockDb({
        selectFirstRow: {
          check_run_id: null,
          build_creation_state: 'pending',
          step_progress_json: null,
          in_progress_sent_at: null,
          run_id: null,
          updated_at: new Date(),
        },
      });
      const store = new CheckRunTrackingStore(db);

      const result = await store.getCheckRunId(KEY);

      expect(result).toBeUndefined();
    });
  });

  describe('getState', () => {
    it('returns undefined when no row exists', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new CheckRunTrackingStore(db);

      const state = await store.getState(KEY);

      expect(state).toBeUndefined();
    });

    it('returns a fully populated state when the row exists', async () => {
      const sentAt = new Date('2026-05-18T10:00:00Z');
      const updated = new Date('2026-05-18T10:05:00Z');
      const { db } = createMockDb({
        selectFirstRow: {
          check_run_id: 12345,
          build_creation_state: 'completed',
          step_progress_json: [{ name: 'step-1', status: 'success', durationMs: 100 }],
          in_progress_sent_at: sentAt,
          run_id: 'run-001',
          updated_at: updated,
        },
      });
      const store = new CheckRunTrackingStore(db);

      const state = await store.getState(KEY);

      expect(state).toBeDefined();
      expect(state?.checkRunId).toBe(12345);
      expect(state?.buildCreationState).toBe('completed');
      expect(state?.stepProgress).toEqual([{ name: 'step-1', status: 'success', durationMs: 100 }]);
      expect(state?.inProgressSentAt).toEqual(sentAt);
      expect(state?.runId).toBe('run-001');
      expect(state?.updatedAt).toEqual(updated);
    });
  });

  describe('listKeysByRunId', () => {
    it('returns the keys for every row matching the runId', async () => {
      const { db, mocks } = createMockDb({
        selectRows: [
          {
            provider: 'github',
            owner: 'myorg',
            repo: 'myrepo',
            sha: 'abc123',
            check_name: 'kici/build',
          },
          {
            provider: 'github',
            owner: 'myorg',
            repo: 'myrepo',
            sha: 'abc123',
            check_name: 'kici/build/job/test',
          },
        ],
      });
      const store = new CheckRunTrackingStore(db);

      const keys = await store.listKeysByRunId('run-001');

      expect(keys).toEqual([
        {
          provider: 'github',
          owner: 'myorg',
          repo: 'myrepo',
          sha: 'abc123',
          checkName: 'kici/build',
        },
        {
          provider: 'github',
          owner: 'myorg',
          repo: 'myrepo',
          sha: 'abc123',
          checkName: 'kici/build/job/test',
        },
      ]);
      expect(mocks.selectWhere).toHaveBeenCalledWith('run_id', '=', 'run-001');
    });

    it('returns an empty array when no rows match', async () => {
      const { db } = createMockDb({ selectRows: [] });
      const store = new CheckRunTrackingStore(db);

      const keys = await store.listKeysByRunId('run-001');

      expect(keys).toEqual([]);
    });
  });

  describe('deleteByRunId', () => {
    it('issues a delete keyed by run_id and returns the row count', async () => {
      const { db, mocks } = createMockDb({ deleteResult: { numDeletedRows: 3n } });
      const store = new CheckRunTrackingStore(db);

      const count = await store.deleteByRunId('run-001');

      expect(count).toBe(3);
      expect(mocks.deleteFrom).toHaveBeenCalledWith('check_run_tracking');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('run_id', '=', 'run-001');
    });

    it('returns 0 when no rows match', async () => {
      const { db } = createMockDb({ deleteResult: { numDeletedRows: 0n } });
      const store = new CheckRunTrackingStore(db);

      const count = await store.deleteByRunId('run-001');

      expect(count).toBe(0);
    });
  });

  describe('deleteRow', () => {
    it('returns true when the row existed', async () => {
      const { db } = createMockDb({ deleteResult: { numDeletedRows: 1n } });
      const store = new CheckRunTrackingStore(db);

      const result = await store.deleteRow(KEY);

      expect(result).toBe(true);
    });

    it('returns false when no row matched', async () => {
      const { db } = createMockDb({ deleteResult: { numDeletedRows: 0n } });
      const store = new CheckRunTrackingStore(db);

      const result = await store.deleteRow(KEY);

      expect(result).toBe(false);
    });
  });

  describe('rowToState', () => {
    it('parses JSON-string step_progress_json defensively', () => {
      const state = rowToState({
        check_run_id: 1,
        build_creation_state: null,
        step_progress_json: JSON.stringify([{ name: 'a', status: 'running' }]),
        in_progress_sent_at: null,
        run_id: null,
        updated_at: new Date(),
      });

      expect(state.stepProgress).toEqual([{ name: 'a', status: 'running' }]);
    });

    it('defaults stepProgress to [] when the column is null', () => {
      const state = rowToState({
        check_run_id: null,
        build_creation_state: null,
        step_progress_json: null,
        in_progress_sent_at: null,
        run_id: null,
        updated_at: new Date(),
      });

      expect(state.stepProgress).toEqual([]);
    });

    it('skips the buildCreationState field on an unknown value', () => {
      const state = rowToState({
        check_run_id: null,
        build_creation_state: 'gibberish',
        step_progress_json: null,
        in_progress_sent_at: null,
        run_id: null,
        updated_at: new Date(),
      });

      expect(state.buildCreationState).toBeUndefined();
    });
  });
});
