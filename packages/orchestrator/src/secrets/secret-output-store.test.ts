/**
 * Tests for SecretOutputStore.
 *
 * Uses mock Kysely to verify:
 * - storeSecretOutput performs upsert into run_secret_outputs
 * - getSecretOutputs returns Record<string, string> for a job
 * - getUpstreamSecretOutputs returns nested Record for multiple jobs
 * - deleteByRunId removes all outputs for a run
 * - cleanupOrphaned deletes expired rows
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecretOutputStore } from './secret-output-store.js';

// ── Chainable Kysely mock builder ──────────────────────────────

import { createMockDb as _createMockDb } from '../__test-helpers__/mock-db.js';

/**
 * Create a mock Kysely DB for SecretOutputStore tests.
 * Returns just the db object for backward compatibility.
 */
function createMockDb(
  opts: {
    selectRows?: Record<string, unknown>[];
    deleteResult?: { numDeletedRows: bigint };
  } = {},
) {
  const { db } = _createMockDb({
    selectRows: opts.selectRows ?? [],
    deleteResult: opts.deleteResult ?? { numDeletedRows: 0n },
  });
  return db;
}

// ── Tests ──────────────────────────────────────────────────────

describe('SecretOutputStore', () => {
  describe('storeSecretOutput', () => {
    it('inserts into run_secret_outputs with upsert', async () => {
      const db = createMockDb();
      const store = new SecretOutputStore(db as any);

      await store.storeSecretOutput('run-1', 'job-a', 'API_KEY', 'encrypted-value-base64');

      expect(db.insertInto).toHaveBeenCalledWith('run_secret_outputs');
    });
  });

  describe('getSecretOutputs', () => {
    it('returns Record<string, string> for given run and job', async () => {
      const rows = [
        { output_key: 'API_KEY', encrypted_value: 'enc-1' },
        { output_key: 'TOKEN', encrypted_value: 'enc-2' },
      ];
      const db = createMockDb({ selectRows: rows });
      const store = new SecretOutputStore(db as any);

      const result = await store.getSecretOutputs('run-1', 'job-a');

      expect(result).toEqual({ API_KEY: 'enc-1', TOKEN: 'enc-2' });
    });

    it('returns empty object when no outputs exist', async () => {
      const db = createMockDb({ selectRows: [] });
      const store = new SecretOutputStore(db as any);

      const result = await store.getSecretOutputs('run-1', 'job-a');

      expect(result).toEqual({});
    });
  });

  describe('getUpstreamSecretOutputs', () => {
    it('returns nested Record<jobId, Record<key, value>>', async () => {
      const rows = [
        { job_id: 'job-a', output_key: 'KEY_1', encrypted_value: 'enc-1' },
        { job_id: 'job-a', output_key: 'KEY_2', encrypted_value: 'enc-2' },
        { job_id: 'job-b', output_key: 'KEY_3', encrypted_value: 'enc-3' },
      ];
      const db = createMockDb({ selectRows: rows });
      const store = new SecretOutputStore(db as any);

      const result = await store.getUpstreamSecretOutputs('run-1', ['job-a', 'job-b']);

      expect(result).toEqual({
        'job-a': { KEY_1: 'enc-1', KEY_2: 'enc-2' },
        'job-b': { KEY_3: 'enc-3' },
      });
    });

    it('returns empty object for empty job list', async () => {
      const db = createMockDb({ selectRows: [] });
      const store = new SecretOutputStore(db as any);

      const result = await store.getUpstreamSecretOutputs('run-1', []);

      expect(result).toEqual({});
    });
  });

  describe('deleteByRunId', () => {
    it('deletes all outputs for a run and returns count', async () => {
      const db = createMockDb({ deleteResult: { numDeletedRows: 5n } });
      const store = new SecretOutputStore(db as any);

      const count = await store.deleteByRunId('run-1');

      expect(count).toBe(5);
      expect(db.deleteFrom).toHaveBeenCalledWith('run_secret_outputs');
    });

    it('returns 0 when no rows to delete', async () => {
      const db = createMockDb({ deleteResult: { numDeletedRows: 0n } });
      const store = new SecretOutputStore(db as any);

      const count = await store.deleteByRunId('run-1');

      expect(count).toBe(0);
    });
  });

  describe('cleanupOrphaned', () => {
    it('deletes rows older than maxAgeHours and returns count', async () => {
      const db = createMockDb({ deleteResult: { numDeletedRows: 10n } });
      const store = new SecretOutputStore(db as any);

      const count = await store.cleanupOrphaned(24);

      expect(count).toBe(10);
      expect(db.deleteFrom).toHaveBeenCalledWith('run_secret_outputs');
    });
  });
});
