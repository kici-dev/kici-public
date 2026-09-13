import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackendSyncManager } from './backend-sync.js';
import type { BackendDescriptor, SecretStore } from '@kici-dev/engine';

/** Minimal mock backend registry. */
function createMockRegistry() {
  const backends: BackendDescriptor[] = [];
  return {
    listBackends: vi.fn(async () => backends),
    getBackend: vi.fn(async (name: string) => backends.find((b) => b.name === name) ?? null),
    getBackendConfig: vi.fn(async (_name: string) => ({ vaultUrl: 'http://vault:8200' })),
    updateSyncStatus: vi.fn(async () => {}),
    createStoreForBackend: vi.fn(
      (_type: string, _config: Record<string, unknown>, _audit: unknown): SecretStore | null =>
        null,
    ),
    _backends: backends,
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeDescriptor(
  overrides: Partial<BackendDescriptor> & { name: string },
): BackendDescriptor {
  return {
    id: 'id-' + overrides.name,
    name: overrides.name,
    backendType: overrides.backendType ?? 'vault',
    scopeFilter: overrides.scopeFilter ?? '**',
    syncIntervalMs: overrides.syncIntervalMs ?? 300000,
    enabled: overrides.enabled ?? true,
    healthStatus: overrides.healthStatus ?? 'healthy',
    scopeCount: overrides.scopeCount ?? 0,
    lastSyncAt: overrides.lastSyncAt ?? null,
    lastSyncError: overrides.lastSyncError ?? null,
    lastHealthCheckAt: overrides.lastHealthCheckAt ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('BackendSyncManager', () => {
  let registry: ReturnType<typeof createMockRegistry>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    registry = createMockRegistry();
    logger = createMockLogger();
  });

  it('syncBackend discovers scopes via single listScopes call', async () => {
    const backend = makeDescriptor({ name: 'vault-prod', backendType: 'vault' });
    registry._backends.push(backend);

    // listScopes('') returns fully-qualified leaf paths (Vault recurses internally)
    const mockStore: Partial<SecretStore> = {
      listScopes: vi.fn(async () => ['org1/aws', 'org1/databases', 'org2/services']),
      getSecrets: vi.fn(async () => ({})),
    };

    registry.createStoreForBackend.mockReturnValue(mockStore as SecretStore);

    const syncManager = new BackendSyncManager(registry as any, logger);
    const result = await syncManager.syncBackend('vault-prod');

    // org1 has 2 scopes, org2 has 1 = 3 total
    expect(result.scopeCount).toBe(3);
    expect(registry.updateSyncStatus).toHaveBeenCalledWith('vault-prod', 3);
  });

  it('syncBackend respects scope filter globs', async () => {
    const backend = makeDescriptor({
      name: 'vault-prod',
      backendType: 'vault',
      scopeFilter: '**/aws/**',
    });
    registry._backends.push(backend);

    const mockStore: Partial<SecretStore> = {
      listScopes: vi.fn(async () => ['org1/aws/prod', 'org1/databases/staging']),
      getSecrets: vi.fn(async () => ({})),
    };
    registry.createStoreForBackend.mockReturnValue(mockStore as SecretStore);

    const syncManager = new BackendSyncManager(registry as any, logger);
    const result = await syncManager.syncBackend('vault-prod');

    // Only 'org1/aws/prod' matches '**/aws/**', not 'org1/databases/staging'
    expect(result.scopeCount).toBe(1);
  });

  it('syncAllBackends syncs all enabled backends', async () => {
    const vault1 = makeDescriptor({ name: 'vault-prod', enabled: true });
    const vault2 = makeDescriptor({ name: 'vault-staging', enabled: true });
    const disabled = makeDescriptor({ name: 'vault-disabled', enabled: false });
    registry._backends.push(vault1, vault2, disabled);

    const mockStore: Partial<SecretStore> = {
      listScopes: vi.fn(async () => ['org1/scope1']),
      getSecrets: vi.fn(async () => ({})),
    };
    registry.createStoreForBackend.mockReturnValue(mockStore as SecretStore);

    const syncManager = new BackendSyncManager(registry as any, logger);
    const results = await syncManager.syncAllBackends();

    // Should only sync enabled backends (2, not 3)
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toEqual(['vault-prod', 'vault-staging']);
  });

  it('updates scope_count and last_sync_at in registry after sync', async () => {
    const backend = makeDescriptor({ name: 'vault-prod' });
    registry._backends.push(backend);

    const mockStore: Partial<SecretStore> = {
      listScopes: vi.fn(async () => ['org1/scope1', 'org1/scope2', 'org1/scope3']),
      getSecrets: vi.fn(async () => ({})),
    };
    registry.createStoreForBackend.mockReturnValue(mockStore as SecretStore);

    const syncManager = new BackendSyncManager(registry as any, logger);
    await syncManager.syncBackend('vault-prod');

    expect(registry.updateSyncStatus).toHaveBeenCalledWith('vault-prod', 3);
  });

  it('handles Vault listing errors gracefully', async () => {
    const backend = makeDescriptor({ name: 'vault-prod' });
    registry._backends.push(backend);

    const mockStore: Partial<SecretStore> = {
      listScopes: vi.fn(async (_orgId: string) => {
        throw new Error('Connection refused');
      }),
    };
    registry.createStoreForBackend.mockReturnValue(mockStore as SecretStore);

    const syncManager = new BackendSyncManager(registry as any, logger);
    const result = await syncManager.syncBackend('vault-prod');

    expect(result.error).toBeDefined();
    expect(result.error).toContain('Connection refused');
    expect(logger.error).toHaveBeenCalled();
    expect(registry.updateSyncStatus).toHaveBeenCalledWith(
      'vault-prod',
      0,
      expect.stringContaining('Connection refused'),
    );
  });

  it('returns error for non-existent backend', async () => {
    const syncManager = new BackendSyncManager(registry as any, logger);
    const result = await syncManager.syncBackend('nonexistent');

    expect(result.error).toBeDefined();
    expect(result.scopeCount).toBe(0);
  });
});
