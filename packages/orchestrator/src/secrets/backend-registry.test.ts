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
const oldKey = deriveKey('b'.repeat(64));
const otherKey = deriveKey('c'.repeat(64));

function makeAuditLogger() {
  return { log: vi.fn(), query: vi.fn() } as any;
}

/**
 * Seed a backend row whose config is encrypted under `key` at `keyVersion`.
 * Defaults to `backend_type: 'pg'` so loadAllStores' store factory does not
 * eagerly connect to an external service (pg reuses the orchestrator DB).
 */
function makeEncryptedRow(
  key: Buffer,
  config: Record<string, unknown>,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const name = (overrides.name as string) ?? 'pg-extra';
  const keyVersion = (overrides.config_key_version as number) ?? 1;
  return {
    id: 'backend-uuid-2',
    name,
    backend_type: 'pg',
    config_encrypted: encrypt(JSON.stringify(config), key, keyVersion, name).data,
    config_key_version: keyVersion,
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

describe('BackendRegistry dual-key decrypt', () => {
  it('decrypts a row sealed under the old key when oldMasterKey is provided', async () => {
    const config = { url: 'https://vault.example' };
    const row = makeEncryptedRow(oldKey, config, { name: 'vault-a' });
    const { db } = createMockDb({ selectFirstRow: row });
    // Current key is testKey; the row is sealed under oldKey.
    const registry = new BackendRegistry(db, testKey, undefined, oldKey);

    const result = await registry.getBackendConfig('vault-a');
    expect(result).toEqual(config);
  });

  it('decrypts a current-key row without any fallback', async () => {
    const config = { url: 'https://vault.example' };
    const row = makeEncryptedRow(testKey, config, { name: 'vault-a' });
    const { db } = createMockDb({ selectFirstRow: row });
    const registry = new BackendRegistry(db, testKey, undefined, oldKey);

    const result = await registry.getBackendConfig('vault-a');
    expect(result).toEqual(config);
  });

  it('throws a recovery-pointing error when BOTH keys fail', async () => {
    // Row sealed under oldKey, but the registry only knows testKey + otherKey.
    const row = makeEncryptedRow(oldKey, { url: 'https://vault.example' }, { name: 'vault-a' });
    const { db } = createMockDb({ selectFirstRow: row });
    const registry = new BackendRegistry(db, testKey, undefined, otherKey);

    await expect(registry.getBackendConfig('vault-a')).rejects.toThrow(
      /secret backend 'vault-a'.*master-key rotation.*KICI_SECRET_KEY_OLD/s,
    );
  });

  it('throws a recovery-pointing error when no old key is configured', async () => {
    const row = makeEncryptedRow(oldKey, { url: 'https://vault.example' }, { name: 'vault-a' });
    const { db } = createMockDb({ selectFirstRow: row });
    // No oldMasterKey provided at all.
    const registry = new BackendRegistry(db, testKey);

    await expect(registry.getBackendConfig('vault-a')).rejects.toThrow(
      /secret backend 'vault-a'.*purge-stale/s,
    );
  });

  it('self-heals a stranded row during loadAllStores (re-seals under current key)', async () => {
    const config = { url: 'https://vault.example' };
    // Row sealed under oldKey at version 1; enabled so loadAllStores picks it up.
    const row = makeEncryptedRow(oldKey, config, { name: 'vault-a', config_key_version: 1 });
    const { db, mocks } = createMockDb({ selectRows: [row] });
    const registry = new BackendRegistry(db, testKey, undefined, oldKey);

    await registry.loadAllStores(makeAuditLogger());

    // Self-heal must re-seal the config under the CURRENT key at a bumped version.
    expect(mocks.updateTable).toHaveBeenCalledWith('secret_backends');
    const setArg = mocks.updateSet.mock.calls[0][0] as {
      config_encrypted: string;
      config_key_version: number;
    };
    expect(setArg.config_key_version).toBe(2); // 1 + 1
    // The resealed ciphertext must decrypt under the current key alone.
    const healed = decrypt(
      { data: setArg.config_encrypted, keyVersion: setArg.config_key_version },
      testKey,
      'vault-a',
    );
    expect(JSON.parse(healed)).toEqual(config);
    // The concurrent-rotation guard pins the update to the observed version.
    expect(mocks.updateWhere).toHaveBeenCalledWith('config_key_version', '=', 1);
  });

  it('does not self-heal a current-key row during loadAllStores', async () => {
    const row = makeEncryptedRow(testKey, { url: 'https://vault.example' }, { name: 'vault-a' });
    const { db, mocks } = createMockDb({ selectRows: [row] });
    const registry = new BackendRegistry(db, testKey, undefined, oldKey);

    await registry.loadAllStores(makeAuditLogger());
    // Already under the current key — no write-back.
    expect(mocks.updateTable).not.toHaveBeenCalled();
  });

  it('never touches sentinel rows (config_encrypted = "") during loadAllStores', async () => {
    const sentinel = makeEncryptedRow(testKey, {}, { name: 'pg', config_encrypted: '' });
    const { db, mocks } = createMockDb({ selectRows: [sentinel] });
    const registry = new BackendRegistry(db, testKey, undefined, oldKey);

    await expect(registry.loadAllStores(makeAuditLogger())).resolves.toBeDefined();
    // Sentinel is never decrypted and never re-sealed.
    expect(mocks.updateTable).not.toHaveBeenCalled();
  });
});

describe('BackendRegistry.rotateKey', () => {
  it('re-encrypts current-key and old-key rows at max(config_key_version)+1', async () => {
    const cfgA = { url: 'https://a.example' };
    const cfgB = { url: 'https://b.example' };
    // rowA under the CURRENT key at v1; rowB under the OLD key at v3.
    const rowA = makeEncryptedRow(testKey, cfgA, {
      id: 'a',
      name: 'vault-a',
      config_key_version: 1,
    });
    const rowB = makeEncryptedRow(oldKey, cfgB, {
      id: 'b',
      name: 'vault-b',
      config_key_version: 3,
    });
    const { db, mocks } = createMockDb({ selectRows: [rowA, rowB] });
    const registry = new BackendRegistry(db, testKey, undefined, oldKey);

    const result = await registry.rotateKey();

    expect(result).toEqual({ reEncrypted: 2, skipped: 0 });
    expect(mocks.transaction).toHaveBeenCalled();
    // Both rows re-sealed at max(3)+1 = 4, decryptable under the current key alone.
    const calls = mocks.updateSet.mock.calls.map((c) => c[0]) as Array<{
      config_encrypted: string;
      config_key_version: number;
    }>;
    expect(calls).toHaveLength(2);
    for (const set of calls) {
      expect(set.config_key_version).toBe(4);
    }
    // Verify the actual plaintext survives under the new key with the right AAD.
    const nameByVersionOrder = ['vault-a', 'vault-b'];
    const expectedByName: Record<string, unknown> = { 'vault-a': cfgA, 'vault-b': cfgB };
    calls.forEach((set, i) => {
      const name = nameByVersionOrder[i];
      const plain = decrypt(
        { data: set.config_encrypted, keyVersion: set.config_key_version },
        testKey,
        name,
      );
      expect(JSON.parse(plain)).toEqual(expectedByName[name]);
    });
  });

  it('skips (never aborts on) a row undecryptable under both keys; sentinels are not candidates', async () => {
    const cfgA = { url: 'https://a.example' };
    // rowA decryptable (current key), rowB sealed under a key neither current nor old.
    const rowA = makeEncryptedRow(testKey, cfgA, { id: 'a', name: 'vault-a' });
    const rowB = makeEncryptedRow(
      otherKey,
      { url: 'https://b.example' },
      {
        id: 'b',
        name: 'vault-b',
      },
    );
    // Sentinel row: the SQL filter excludes it, but seed it to prove the
    // in-loop guard never counts it as skipped even if it slips through.
    const sentinel = makeEncryptedRow(testKey, {}, { id: 'pg', name: 'pg', config_encrypted: '' });
    const { db } = createMockDb({ selectRows: [rowA, rowB, sentinel] });
    const registry = new BackendRegistry(db, testKey, undefined, oldKey);

    const result = await registry.rotateKey();

    expect(result.reEncrypted).toBe(1); // only rowA
    expect(result.skipped).toBe(1); // rowB; sentinel not counted
  });

  it('returns zero counts when there are no non-sentinel backends', async () => {
    const { db } = createMockDb({ selectRows: [] });
    const registry = new BackendRegistry(db, testKey, undefined, oldKey);

    const result = await registry.rotateKey();
    expect(result).toEqual({ reEncrypted: 0, skipped: 0 });
  });
});
