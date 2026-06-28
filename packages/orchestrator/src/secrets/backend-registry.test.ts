/**
 * Tests for BackendRegistry.
 *
 * Verifies CRUD operations on secret_backends table, config encryption,
 * and SecretStore factory methods.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackendRegistry } from './backend-registry.js';
import { encrypt, decrypt, deriveKey } from '@kici-dev/shared';
import { createMockDb } from '../__test-helpers__/mock-db.js';

// ── Test fixtures ──────────────────────────────────────────────

const testKey = deriveKey('a'.repeat(64));

function makeAuditLogger() {
  return { log: vi.fn(), query: vi.fn() } as any;
}

const now = new Date('2026-03-28T10:00:00Z');

function makeBackendRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'backend-uuid-1',
    name: 'my-vault',
    backend_type: 'vault',
    config_encrypted: encrypt(
      JSON.stringify({
        vaultUrl: 'http://vault:8200',
        basePath: 'kici',
        authMethod: 'token',
        token: 's.abc123',
      }),
      testKey,
      1,
      'my-vault',
    ).data,
    config_key_version: 1,
    scope_filter: '**',
    sync_interval_ms: 300000,
    enabled: true,
    last_sync_at: null,
    last_sync_error: null,
    last_health_check_at: null,
    health_status: 'unknown',
    scope_count: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe('BackendRegistry', () => {
  describe('listBackends', () => {
    it('returns empty array when no backends in DB', async () => {
      const { db } = createMockDb({ selectRows: [] });
      const registry = new BackendRegistry(db, testKey);

      const result = await registry.listBackends();
      expect(result).toEqual([]);
    });

    it('returns all registered backends with descriptor fields', async () => {
      const row = makeBackendRow();
      const { db } = createMockDb({ selectRows: [row] });
      const registry = new BackendRegistry(db, testKey);

      const result = await registry.listBackends();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('my-vault');
      expect(result[0].backendType).toBe('vault');
      expect(result[0].enabled).toBe(true);
      expect(result[0].healthStatus).toBe('unknown');
    });
  });

  describe('addBackend', () => {
    it('stores encrypted config and returns descriptor', async () => {
      const returnedRow = makeBackendRow({ name: 'new-vault' });
      const { db, mocks } = createMockDb({ insertedRow: returnedRow });
      const registry = new BackendRegistry(db, testKey);

      const result = await registry.addBackend({
        name: 'new-vault',
        backendType: 'vault',
        config: {
          vaultUrl: 'http://vault:8200',
          basePath: 'kici',
          authMethod: 'token',
          token: 's.test',
        },
      });

      expect(result.name).toBe('new-vault');
      expect(result.backendType).toBe('vault');

      // Verify insertInto was called with secret_backends
      expect(mocks.insertInto).toHaveBeenCalledWith('secret_backends');

      // Verify the values contain encrypted config (not plaintext)
      const insertCall = mocks.insertValues.mock.calls[0][0];
      expect(insertCall.config_encrypted).toBeDefined();
      expect(insertCall.config_encrypted).not.toContain('vaultUrl');
      expect(insertCall.name).toBe('new-vault');
      expect(insertCall.backend_type).toBe('vault');
    });
  });

  describe('ensureDefaultPgBackend', () => {
    it('upserts the default pg row with empty config sentinel (idempotent)', async () => {
      const { db, mocks } = createMockDb({});
      const registry = new BackendRegistry(db, testKey);

      await registry.ensureDefaultPgBackend();

      expect(mocks.insertInto).toHaveBeenCalledWith('secret_backends');
      const insertCall = mocks.insertValues.mock.calls[0][0];
      expect(insertCall.name).toBe('pg');
      expect(insertCall.backend_type).toBe('pg');
      expect(insertCall.config_encrypted).toBe('');
      expect(insertCall.scope_filter).toBe('**');
      expect(mocks.onConflict).toHaveBeenCalled();
    });
  });

  describe('removeBackend', () => {
    it('returns true when backend is deleted', async () => {
      const { db } = createMockDb({ deleteResult: { numDeletedRows: 1n } });
      const registry = new BackendRegistry(db, testKey);

      const result = await registry.removeBackend('my-vault');
      expect(result).toBe(true);
    });

    it('returns false for nonexistent backend', async () => {
      const { db } = createMockDb({ deleteResult: { numDeletedRows: 0n } });
      const registry = new BackendRegistry(db, testKey);

      const result = await registry.removeBackend('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getBackend', () => {
    it('returns single backend by name', async () => {
      const row = makeBackendRow();
      const { db } = createMockDb({ selectFirstRow: row });
      const registry = new BackendRegistry(db, testKey);

      const result = await registry.getBackend('my-vault');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('my-vault');
      expect(result!.backendType).toBe('vault');
    });

    it('returns null for nonexistent backend', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const registry = new BackendRegistry(db, testKey);

      const result = await registry.getBackend('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getBackendConfig', () => {
    it('returns decrypted config for existing backend', async () => {
      const row = makeBackendRow();
      const { db } = createMockDb({ selectFirstRow: row });
      const registry = new BackendRegistry(db, testKey);

      const config = await registry.getBackendConfig('my-vault');
      expect(config).not.toBeNull();
      expect(config!.vaultUrl).toBe('http://vault:8200');
      expect(config!.basePath).toBe('kici');
    });

    it('returns null for nonexistent backend', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const registry = new BackendRegistry(db, testKey);

      const config = await registry.getBackendConfig('nonexistent');
      expect(config).toBeNull();
    });
  });

  describe('createStoreForBackend', () => {
    it('returns PgSecretStore for type pg', () => {
      const { db } = createMockDb();
      const registry = new BackendRegistry(db, testKey);
      const auditLogger = makeAuditLogger();

      const store = registry.createStoreForBackend('pg', {}, auditLogger);
      expect(store).not.toBeNull();
      expect(store!.constructor.name).toBe('PgSecretStore');
    });

    it('returns VaultSecretStore for type vault', () => {
      const { db } = createMockDb();
      const registry = new BackendRegistry(db, testKey);
      const auditLogger = makeAuditLogger();

      const store = registry.createStoreForBackend(
        'vault',
        { vaultUrl: 'http://vault:8200', basePath: 'kici', authMethod: 'token', token: 's.test' },
        auditLogger,
      );
      expect(store).not.toBeNull();
      expect(store!.constructor.name).toBe('VaultSecretStore');
    });
  });

  describe('config encryption', () => {
    it('config is encrypted in DB (raw value is not plaintext)', async () => {
      const returnedRow = makeBackendRow();
      const { db, mocks } = createMockDb({ insertedRow: returnedRow });
      const registry = new BackendRegistry(db, testKey);

      await registry.addBackend({
        name: 'encrypted-test',
        backendType: 'vault',
        config: { vaultUrl: 'http://secret-vault:8200', basePath: 'test' },
      });

      const insertCall = mocks.insertValues.mock.calls[0][0];
      const encryptedConfig = insertCall.config_encrypted;

      // The raw DB value should be base64-encoded ciphertext, not plaintext JSON
      expect(encryptedConfig).not.toContain('secret-vault');
      expect(encryptedConfig).not.toContain('{');

      // Decrypting with the correct key and AAD should yield the original config
      const decrypted = decrypt(
        { data: encryptedConfig, keyVersion: 1 },
        testKey,
        'encrypted-test',
      );
      const parsed = JSON.parse(decrypted);
      expect(parsed.vaultUrl).toBe('http://secret-vault:8200');
    });
  });

  describe('updateHealthStatus', () => {
    it('updates health status fields', async () => {
      const { db, mocks } = createMockDb();
      const registry = new BackendRegistry(db, testKey);

      await registry.updateHealthStatus('my-vault', 'healthy');
      expect(mocks.updateTable).toHaveBeenCalledWith('secret_backends');
    });
  });

  describe('updateSyncStatus', () => {
    it('updates sync status fields', async () => {
      const { db, mocks } = createMockDb();
      const registry = new BackendRegistry(db, testKey);

      await registry.updateSyncStatus('my-vault', 42);
      expect(mocks.updateTable).toHaveBeenCalledWith('secret_backends');
    });
  });
});
