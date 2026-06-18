/**
 * Tests for BindingStore -- scope-to-environment binding CRUD.
 *
 * Uses the shared mock Kysely builder.
 */
import { describe, it, expect } from 'vitest';

import { BindingStore } from './binding-store.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

// ── Fixtures ──────────────────────────────────────────────────────

function makeBindingRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'bind-001',
    org_id: 'org-abc',
    environment_id: 'env-001',
    scope_pattern: 'aws/prod/**',
    created_at: new Date('2026-03-08T10:00:00Z'),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('BindingStore', () => {
  describe('list', () => {
    it('should return all bindings for an environment', async () => {
      const rows = [
        makeBindingRow({ scope_pattern: 'aws/prod/**' }),
        makeBindingRow({ id: 'bind-002', scope_pattern: 'databases/*' }),
      ];
      const { db, mocks } = createMockDb({ selectRows: rows });
      const store = new BindingStore(db);

      const result = await store.list('org-abc', 'env-001');

      expect(result).toHaveLength(2);
      expect(mocks.selectFrom).toHaveBeenCalledWith('environment_bindings');
      expect(mocks.selectWhere).toHaveBeenCalledWith('org_id', '=', 'org-abc');
      expect(mocks.selectWhere).toHaveBeenCalledWith('environment_id', '=', 'env-001');
    });

    it('should return empty array when no bindings exist', async () => {
      const { db } = createMockDb({ selectRows: [] });
      const store = new BindingStore(db);

      const result = await store.list('org-abc', 'env-001');

      expect(result).toEqual([]);
    });
  });

  describe('set', () => {
    it('should replace all bindings in a transaction', async () => {
      const { db, mocks } = createMockDb();
      const store = new BindingStore(db);

      await store.set('org-abc', 'env-001', ['aws/prod/**', 'databases/*']);

      // Transaction should have been used
      expect(mocks.transaction).toHaveBeenCalled();
      // Should delete existing bindings
      expect(mocks.deleteFrom).toHaveBeenCalledWith('environment_bindings');
      // Should insert new bindings
      expect(mocks.insertInto).toHaveBeenCalledWith('environment_bindings');
    });

    it('should deduplicate scope patterns before inserting', async () => {
      const { db, mocks } = createMockDb();
      const store = new BindingStore(db);

      await store.set('org-abc', 'env-001', ['aws/prod/**', 'databases/*', 'aws/prod/**']);

      // Transaction should have been used
      expect(mocks.transaction).toHaveBeenCalled();
      // Should insert with deduplicated values (2 unique patterns, not 3)
      expect(mocks.insertValues).toHaveBeenCalledWith([
        { org_id: 'org-abc', environment_id: 'env-001', scope_pattern: 'aws/prod/**' },
        { org_id: 'org-abc', environment_id: 'env-001', scope_pattern: 'databases/*' },
      ]);
    });

    it('should clear bindings when given empty array', async () => {
      const { db, mocks } = createMockDb();
      const store = new BindingStore(db);

      await store.set('org-abc', 'env-001', []);

      // Should delete existing but not insert
      expect(mocks.deleteFrom).toHaveBeenCalledWith('environment_bindings');
      expect(mocks.insertInto).not.toHaveBeenCalled();
    });
  });

  describe('findBindingsForEnvironment', () => {
    it('should return bindings (alias for list)', async () => {
      const rows = [makeBindingRow()];
      const { db } = createMockDb({ selectRows: rows });
      const store = new BindingStore(db);

      const result = await store.findBindingsForEnvironment('org-abc', 'env-001');

      expect(result).toHaveLength(1);
    });
  });
});
