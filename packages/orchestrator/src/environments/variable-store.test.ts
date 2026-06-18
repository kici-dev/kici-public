/**
 * Tests for VariableStore -- environment variable CRUD with lock enforcement.
 *
 * Uses the shared mock Kysely builder.
 */
import { describe, it, expect, vi } from 'vitest';

import { VariableStore } from './variable-store.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

// ── Fixtures ──────────────────────────────────────────────────────

function makeVarRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'var-001',
    org_id: 'org-abc',
    environment_id: 'env-001',
    key: 'API_URL',
    value: 'https://api.example.com',
    locked: false,
    created_at: new Date('2026-03-08T10:00:00Z'),
    updated_at: new Date('2026-03-08T10:00:00Z'),
    ...overrides,
  };
}

function makeOverrideRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'ovr-001',
    org_id: 'org-abc',
    environment_id: 'env-001',
    routing_key: 'github:42',
    key: 'API_URL',
    value: 'https://api-override.example.com',
    created_at: new Date('2026-03-08T10:00:00Z'),
    updated_at: new Date('2026-03-08T10:00:00Z'),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('VariableStore', () => {
  describe('listVars', () => {
    it('should return all org-level vars for environment', async () => {
      const rows = [makeVarRow({ key: 'API_URL' }), makeVarRow({ id: 'var-002', key: 'DB_HOST' })];
      const { db, mocks } = createMockDb({ selectRows: rows });
      const store = new VariableStore(db);

      const result = await store.listVars('org-abc', 'env-001');

      expect(result).toHaveLength(2);
      expect(mocks.selectFrom).toHaveBeenCalledWith('environment_variables');
      expect(mocks.selectWhere).toHaveBeenCalledWith('org_id', '=', 'org-abc');
      expect(mocks.selectWhere).toHaveBeenCalledWith('environment_id', '=', 'env-001');
    });
  });

  describe('setVar', () => {
    it('should upsert a variable', async () => {
      const { db, mocks } = createMockDb();
      const store = new VariableStore(db);

      await store.setVar('org-abc', 'env-001', 'API_URL', 'https://api.example.com', false);

      expect(mocks.insertInto).toHaveBeenCalledWith('environment_variables');
      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-abc',
          environment_id: 'env-001',
          key: 'API_URL',
          value: 'https://api.example.com',
          locked: false,
        }),
      );
    });
  });

  describe('deleteVar', () => {
    it('should delete a variable', async () => {
      const { db, mocks } = createMockDb({ deleteResult: { numDeletedRows: 1n } });
      const store = new VariableStore(db);

      await store.deleteVar('org-abc', 'env-001', 'API_URL');

      expect(mocks.deleteFrom).toHaveBeenCalledWith('environment_variables');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('org_id', '=', 'org-abc');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('environment_id', '=', 'env-001');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('key', '=', 'API_URL');
    });
  });

  describe('listSourceOverrides', () => {
    it('should return overrides for a source', async () => {
      const rows = [makeOverrideRow()];
      const { db, mocks } = createMockDb({ selectRows: rows });
      const store = new VariableStore(db);

      const result = await store.listSourceOverrides('org-abc', 'env-001', 'github:42');

      expect(result).toHaveLength(1);
      expect(mocks.selectFrom).toHaveBeenCalledWith('environment_source_overrides');
      expect(mocks.selectWhere).toHaveBeenCalledWith('routing_key', '=', 'github:42');
    });
  });

  describe('setSourceOverride', () => {
    it('should upsert a source override', async () => {
      const { db, mocks } = createMockDb();
      const store = new VariableStore(db);

      await store.setSourceOverride(
        'org-abc',
        'env-001',
        'github:42',
        'API_URL',
        'https://api-override.example.com',
      );

      expect(mocks.insertInto).toHaveBeenCalledWith('environment_source_overrides');
      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-abc',
          environment_id: 'env-001',
          routing_key: 'github:42',
          key: 'API_URL',
          value: 'https://api-override.example.com',
        }),
      );
    });
  });

  describe('deleteSourceOverride', () => {
    it('should delete a source override', async () => {
      const { db, mocks } = createMockDb({ deleteResult: { numDeletedRows: 1n } });
      const store = new VariableStore(db);

      await store.deleteSourceOverride('org-abc', 'env-001', 'github:42', 'API_URL');

      expect(mocks.deleteFrom).toHaveBeenCalledWith('environment_source_overrides');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('routing_key', '=', 'github:42');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('key', '=', 'API_URL');
    });
  });

  describe('getResolvedVars', () => {
    it('should return only org vars when no routingKey provided', async () => {
      const store = new VariableStore(null as any);
      // Mock listVars and listSourceOverrides
      vi.spyOn(store, 'listVars').mockResolvedValue([
        makeVarRow({ key: 'API_URL', value: 'org-val', locked: false }) as any,
        makeVarRow({ key: 'DB_HOST', value: 'db.example.com', locked: true }) as any,
      ]);

      const result = await store.getResolvedVars('org-abc', 'env-001');

      expect(result).toEqual({
        API_URL: 'org-val',
        DB_HOST: 'db.example.com',
      });
    });

    it('should merge source overrides for unlocked vars', async () => {
      const store = new VariableStore(null as any);
      vi.spyOn(store, 'listVars').mockResolvedValue([
        makeVarRow({ key: 'API_URL', value: 'org-val', locked: false }) as any,
      ]);
      vi.spyOn(store, 'listSourceOverrides').mockResolvedValue([
        makeOverrideRow({ key: 'API_URL', value: 'source-val' }) as any,
      ]);

      const result = await store.getResolvedVars('org-abc', 'env-001', 'github:42');

      expect(result).toEqual({ API_URL: 'source-val' });
    });

    it('should NOT override locked vars with source overrides', async () => {
      const store = new VariableStore(null as any);
      vi.spyOn(store, 'listVars').mockResolvedValue([
        makeVarRow({ key: 'API_URL', value: 'locked-val', locked: true }) as any,
      ]);
      vi.spyOn(store, 'listSourceOverrides').mockResolvedValue([
        makeOverrideRow({ key: 'API_URL', value: 'should-be-ignored' }) as any,
      ]);

      const result = await store.getResolvedVars('org-abc', 'env-001', 'github:42');

      expect(result).toEqual({ API_URL: 'locked-val' });
    });

    it('should allow source overrides to add new keys not at org level', async () => {
      const store = new VariableStore(null as any);
      vi.spyOn(store, 'listVars').mockResolvedValue([
        makeVarRow({ key: 'API_URL', value: 'org-val', locked: false }) as any,
      ]);
      vi.spyOn(store, 'listSourceOverrides').mockResolvedValue([
        makeOverrideRow({ key: 'EXTRA_VAR', value: 'extra-val' }) as any,
      ]);

      const result = await store.getResolvedVars('org-abc', 'env-001', 'github:42');

      expect(result).toEqual({
        API_URL: 'org-val',
        EXTRA_VAR: 'extra-val',
      });
    });
  });
});
