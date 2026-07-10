/**
 * Tests for ContextStore -- CRUD operations and glob pattern matching.
 *
 * Uses the shared mock Kysely builder.
 */
import { describe, it, expect } from 'vitest';

import { ContextDeleteBlockedError, ContextStore, toContext } from './context-store.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

// ── Fixtures ──────────────────────────────────────────────────────

function makeEnvRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'env-001',
    org_id: 'org-abc',
    name: 'production',
    type: 'fixed',
    glob_pattern: null,
    branch_restrictions: '[]',
    trigger_type_filters: '[]',
    repo_patterns: '[]',
    concurrency_limit: null,
    concurrency_strategy: 'queue',
    concurrency_timeout_ms: 1800000,
    required_reviewers: null,
    wait_timer_seconds: null,
    hold_expiry_seconds: 86400,
    minimum_trust: null,
    enabled: true,
    created_at: new Date('2026-03-08T10:00:00Z'),
    updated_at: new Date('2026-03-08T10:00:00Z'),
    created_by: 'user:admin',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('ContextStore', () => {
  describe('list', () => {
    it('should return all contexts for org ordered by name', async () => {
      const rows = [
        makeEnvRow({ name: 'production' }),
        makeEnvRow({ id: 'env-002', name: 'staging' }),
      ];
      const { db, mocks } = createMockDb({ selectRows: rows });
      const store = new ContextStore(db);

      const result = await store.list('org-abc');

      expect(result).toHaveLength(2);
      expect(mocks.selectFrom).toHaveBeenCalledWith('contexts');
      expect(mocks.selectWhere).toHaveBeenCalledWith('org_id', '=', 'org-abc');
      expect(mocks.selectOrderBy).toHaveBeenCalledWith('name', 'asc');
    });

    it('should return empty array when no contexts exist', async () => {
      const { db } = createMockDb({ selectRows: [] });
      const store = new ContextStore(db);

      const result = await store.list('org-abc');

      expect(result).toEqual([]);
    });
  });

  describe('get', () => {
    it('should return context by id', async () => {
      const row = makeEnvRow();
      const { db, mocks } = createMockDb({ selectFirstRow: row });
      const store = new ContextStore(db);

      const result = await store.get('org-abc', 'env-001');

      expect(result).toEqual(row);
      expect(mocks.selectWhere).toHaveBeenCalledWith('org_id', '=', 'org-abc');
      expect(mocks.selectWhere).toHaveBeenCalledWith('id', '=', 'env-001');
    });

    it('should return null when not found', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new ContextStore(db);

      const result = await store.get('org-abc', 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getByName', () => {
    it('should return context by name', async () => {
      const row = makeEnvRow({ name: 'staging' });
      const { db, mocks } = createMockDb({ selectFirstRow: row });
      const store = new ContextStore(db);

      const result = await store.getByName('org-abc', 'staging');

      expect(result).toEqual(row);
      expect(mocks.selectWhere).toHaveBeenCalledWith('name', '=', 'staging');
    });

    it('should return null when not found', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new ContextStore(db);

      const result = await store.getByName('org-abc', 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('should insert context and return created row', async () => {
      const row = makeEnvRow();
      const { db, mocks } = createMockDb({ insertedRow: row });
      const store = new ContextStore(db);

      const result = await store.create('org-abc', {
        name: 'production',
        type: 'fixed',
      });

      expect(result).toEqual(row);
      expect(mocks.insertInto).toHaveBeenCalledWith('contexts');
      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-abc',
          name: 'production',
          type: 'fixed',
        }),
      );
    });
  });

  describe('update', () => {
    it('should update context and return updated row', async () => {
      const row = makeEnvRow({ name: 'production-v2' });
      const { db, mocks } = createMockDb({ updatedRow: row });
      const store = new ContextStore(db);

      const result = await store.update('org-abc', 'env-001', { name: 'production-v2' });

      expect(result).toEqual(row);
      expect(mocks.updateTable).toHaveBeenCalledWith('contexts');
      expect(mocks.updateWhere).toHaveBeenCalledWith('org_id', '=', 'org-abc');
      expect(mocks.updateWhere).toHaveBeenCalledWith('id', '=', 'env-001');
    });

    it('should return null when context not found', async () => {
      const { db } = createMockDb({ updatedRow: undefined });
      const store = new ContextStore(db);

      const result = await store.update('org-abc', 'nonexistent', { name: 'x' });

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should return true when context deleted', async () => {
      const { db, mocks } = createMockDb({ deleteResult: { numDeletedRows: 1n } });
      const store = new ContextStore(db);

      const deleted = await store.delete('org-abc', 'env-001');

      expect(deleted).toBe(true);
      expect(mocks.deleteFrom).toHaveBeenCalledWith('contexts');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('org_id', '=', 'org-abc');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('id', '=', 'env-001');
    });

    it('should return false when context not found', async () => {
      const { db } = createMockDb({ deleteResult: { numDeletedRows: 0n } });
      const store = new ContextStore(db);

      const deleted = await store.delete('org-abc', 'nonexistent');

      expect(deleted).toBe(false);
    });

    it('should throw ContextDeleteBlockedError when pending held runs exist', async () => {
      // The pending-count query resolves via the select chain's executeTakeFirst.
      const { db, mocks } = createMockDb({
        selectFirstRow: { count: '2' },
        deleteResult: { numDeletedRows: 1n },
      });
      const store = new ContextStore(db);

      await expect(store.delete('org-abc', 'env-001')).rejects.toBeInstanceOf(
        ContextDeleteBlockedError,
      );
      await expect(store.delete('org-abc', 'env-001')).rejects.toMatchObject({
        pendingCount: 2,
        message: 'Context has 2 pending held run(s) — approve or reject them first',
      });
      // Deletion must not run when pending held runs block it.
      expect(mocks.deleteFrom).not.toHaveBeenCalled();
    });

    it('should proceed when only terminal held runs exist', async () => {
      const { db, mocks } = createMockDb({
        selectFirstRow: { count: '0' },
        deleteResult: { numDeletedRows: 1n },
      });
      const store = new ContextStore(db);

      const deleted = await store.delete('org-abc', 'env-001');

      expect(deleted).toBe(true);
      expect(mocks.deleteFrom).toHaveBeenCalledWith('contexts');
    });
  });

  describe('toContext', () => {
    it('should map snake_case DB row to camelCase engine type', () => {
      const row = makeEnvRow() as any;
      const env = toContext(row);

      expect(env.id).toBe('env-001');
      expect(env.orgId).toBe('org-abc');
      expect(env.name).toBe('production');
      expect(env.type).toBe('fixed');
      expect(env.globPattern).toBeNull();
      expect(env.branchRestrictions).toEqual([]);
      expect(env.triggerTypeFilters).toEqual([]);
      expect(env.repoPatterns).toEqual([]);
      expect(env.concurrencyLimit).toBeNull();
      expect(env.concurrencyStrategy).toBe('queue');
      expect(env.concurrencyTimeoutMs).toBe(1800000);
      expect(env.requiredReviewers).toBeNull();
      expect(env.waitTimerSeconds).toBeNull();
      expect(env.holdExpirySeconds).toBe(86400);
      expect(env.minimumTrust).toBeUndefined();
      expect(env.enabled).toBe(true);
      expect(env.createdAt).toBe('2026-03-08T10:00:00.000Z');
      expect(env.updatedAt).toBe('2026-03-08T10:00:00.000Z');
      expect(env.createdBy).toBe('user:admin');
    });

    it('should parse JSONB string arrays', () => {
      const row = makeEnvRow({
        branch_restrictions: '["main","release/*"]',
        trigger_type_filters: '["push","pull_request"]',
        repo_patterns: '["org/repo-*"]',
        required_reviewers: '["alice","bob"]',
      }) as any;
      const env = toContext(row);

      expect(env.branchRestrictions).toEqual(['main', 'release/*']);
      expect(env.triggerTypeFilters).toEqual(['push', 'pull_request']);
      expect(env.repoPatterns).toEqual(['org/repo-*']);
      expect(env.requiredReviewers).toEqual(['alice', 'bob']);
    });

    it('should handle invalid JSON gracefully', () => {
      const row = makeEnvRow({
        branch_restrictions: 'not-json',
        required_reviewers: '{bad}',
      }) as any;
      const env = toContext(row);

      expect(env.branchRestrictions).toEqual([]);
      expect(env.requiredReviewers).toBeNull();
    });

    it('should map minimum_trust to minimumTrust', () => {
      const row = makeEnvRow({ minimum_trust: 'trusted' }) as any;
      const env = toContext(row);

      expect(env.minimumTrust).toBe('trusted');
    });

    it('should handle string timestamps (non-Date objects)', () => {
      const row = makeEnvRow({
        created_at: '2026-03-08T10:00:00Z',
        updated_at: '2026-03-08T10:00:00Z',
      }) as any;
      const env = toContext(row);

      expect(env.createdAt).toBe('2026-03-08T10:00:00Z');
      expect(env.updatedAt).toBe('2026-03-08T10:00:00Z');
    });
  });

  describe('matchContext', () => {
    it('should return exact match first', async () => {
      const row = makeEnvRow({ name: 'review/PR-42', type: 'fixed' });
      // First call (getByName) returns exact match
      const { db } = createMockDb({ selectFirstRow: row });
      const store = new ContextStore(db);

      const result = await store.matchContext('org-abc', 'review/PR-42');

      expect(result).toEqual(row);
    });

    it('should fall back to glob pattern match when no exact match', async () => {
      const globRow = makeEnvRow({
        id: 'env-glob',
        name: 'review-envs',
        type: 'glob',
        glob_pattern: 'review/*',
      });
      // First call (getByName) returns null, second call (list of glob envs) returns [globRow]
      const { db, mocks } = createMockDb({
        selectFirstRow: undefined,
        selectRows: [globRow],
      });
      const store = new ContextStore(db);

      const result = await store.matchContext('org-abc', 'review/PR-42');

      expect(result).toEqual(globRow);
    });

    it('should return disabled glob context so protection pipeline can reject it', async () => {
      const disabledGlobRow = makeEnvRow({
        id: 'env-glob-disabled',
        name: 'review-envs',
        type: 'glob',
        glob_pattern: 'review/*',
        enabled: false,
      });
      const { db } = createMockDb({
        selectFirstRow: undefined,
        selectRows: [disabledGlobRow],
      });
      const store = new ContextStore(db);

      const result = await store.matchContext('org-abc', 'review/PR-42');

      // Should return the disabled env (not null) so the protection pipeline
      // can reject it with a proper "disabled" message instead of silently
      // bypassing protection
      expect(result).toEqual(disabledGlobRow);
    });

    it('should return null when no match found', async () => {
      const { db } = createMockDb({
        selectFirstRow: undefined,
        selectRows: [],
      });
      const store = new ContextStore(db);

      const result = await store.matchContext('org-abc', 'nonexistent');

      expect(result).toBeNull();
    });
  });
});
