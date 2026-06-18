import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VaultSecretStore } from './vault-secret-store.js';
import type { VaultConfig } from './vault-secret-store.js';
import type { Logger } from '@kici-dev/shared';

// Mock hashi-vault-js
vi.mock('hashi-vault-js', () => {
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        loginWithAppRole: vi.fn(),
        readKVSecret: vi.fn(),
        createKVSecret: vi.fn(),
        updateKVSecret: vi.fn(),
        eliminateKVSecret: vi.fn(),
        listKVSecrets: vi.fn(),
      };
    }),
  };
});

function createMockLogger(): Logger & { debug: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger & { debug: ReturnType<typeof vi.fn> };
}

function createVaultError(
  status: number,
): Error & { isVaultError: boolean; response: { status: number } } {
  const err = new Error(`Vault error ${status}`) as Error & {
    isVaultError: boolean;
    response: { status: number };
  };
  err.isVaultError = true;
  err.response = { status };
  return err;
}

function getClient(store: VaultSecretStore): Record<string, ReturnType<typeof vi.fn>> {
  return (store as unknown as { client: Record<string, ReturnType<typeof vi.fn>> }).client;
}

describe('VaultSecretStore', () => {
  let store: VaultSecretStore;
  let config: VaultConfig;
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createMockLogger();
  });

  describe('with token auth', () => {
    beforeEach(() => {
      config = {
        vaultUrl: 'http://vault:8200',
        authMethod: 'token',
        token: 'test-vault-token',
        basePath: 'kici/secrets',
        mountPath: 'secret',
      };
      store = new VaultSecretStore(config, logger);
    });

    it('reads secrets from correct Vault path', async () => {
      const client = getClient(store);
      client.readKVSecret.mockResolvedValue({
        data: { DB_PASSWORD: 'secret123', API_KEY: 'key456' },
        metadata: { version: 1 },
      });

      const result = await store.getSecrets('org-001', 'aws/prod');

      expect(client.readKVSecret).toHaveBeenCalledWith(
        'test-vault-token',
        'kici/secrets/org-001/aws/prod',
        undefined,
        'secret',
      );
      expect(result).toEqual({ DB_PASSWORD: 'secret123', API_KEY: 'key456' });
    });

    it('returns empty record for 404 path', async () => {
      const client = getClient(store);
      client.readKVSecret.mockRejectedValue(createVaultError(404));

      const result = await store.getSecrets('org-001', 'nonexistent');

      expect(result).toEqual({});
    });

    it('sets a secret by merging with existing data', async () => {
      const client = getClient(store);
      client.readKVSecret.mockResolvedValue({
        data: { EXISTING: 'value1' },
        metadata: { version: 2 },
      });
      client.updateKVSecret.mockResolvedValue({});

      await store.setSecret('org-001', 'aws/prod', 'NEW_KEY', 'new_value');

      expect(client.updateKVSecret).toHaveBeenCalledWith(
        'test-vault-token',
        'kici/secrets/org-001/aws/prod',
        { EXISTING: 'value1', NEW_KEY: 'new_value' },
        2,
        'secret',
      );
    });

    it('creates a new secret path when none exists', async () => {
      const client = getClient(store);
      client.readKVSecret.mockRejectedValue(createVaultError(404));
      client.createKVSecret.mockResolvedValue({});

      await store.setSecret('org-001', 'new-scope', 'MY_SECRET', 'my_value');

      expect(client.createKVSecret).toHaveBeenCalledWith(
        'test-vault-token',
        'kici/secrets/org-001/new-scope',
        { MY_SECRET: 'my_value' },
        'secret',
      );
    });

    it('deletes a key and writes remaining secrets', async () => {
      const client = getClient(store);
      client.readKVSecret.mockResolvedValue({
        data: { KEEP: 'keep_me', REMOVE: 'remove_me' },
        metadata: { version: 3 },
      });
      client.updateKVSecret.mockResolvedValue({});

      await store.deleteSecret('org-001', 'aws/prod', 'REMOVE');

      expect(client.updateKVSecret).toHaveBeenCalledWith(
        'test-vault-token',
        'kici/secrets/org-001/aws/prod',
        { KEEP: 'keep_me' },
        3,
        'secret',
      );
    });

    it('eliminates path when deleting the last secret', async () => {
      const client = getClient(store);
      client.readKVSecret.mockResolvedValue({
        data: { LAST_ONE: 'value' },
        metadata: { version: 1 },
      });
      client.eliminateKVSecret.mockResolvedValue({});

      await store.deleteSecret('org-001', 'aws/prod', 'LAST_ONE');

      expect(client.eliminateKVSecret).toHaveBeenCalledWith(
        'test-vault-token',
        'kici/secrets/org-001/aws/prod',
        'secret',
      );
    });

    it('delete is a no-op for nonexistent path', async () => {
      const client = getClient(store);
      client.readKVSecret.mockRejectedValue(createVaultError(404));

      await store.deleteSecret('org-001', 'nonexistent', 'KEY');

      expect(client.updateKVSecret).not.toHaveBeenCalled();
      expect(client.eliminateKVSecret).not.toHaveBeenCalled();
    });

    it('listKeys returns key names', async () => {
      const client = getClient(store);
      client.readKVSecret.mockResolvedValue({
        data: { A: '1', B: '2', C: '3' },
        metadata: { version: 1 },
      });

      const keys = await store.listKeys('org-001', 'aws/prod');

      expect(keys).toEqual(['A', 'B', 'C']);
    });

    it('listKeys returns empty array for nonexistent path', async () => {
      const client = getClient(store);
      client.readKVSecret.mockRejectedValue(createVaultError(404));

      const keys = await store.listKeys('org-001', 'nonexistent');

      expect(keys).toEqual([]);
    });

    it('listScopes recurses into directories and returns leaf scopes', async () => {
      const client = getClient(store);
      // First call: root listing returns directories
      // Subsequent calls: each directory returns a leaf entry (no trailing slash)
      client.listKVSecrets
        .mockResolvedValueOnce({
          keys: ['cloud/', 'databases/', 'services/'],
        })
        .mockResolvedValueOnce({
          keys: ['aws-prod'],
        })
        .mockResolvedValueOnce({
          keys: ['postgres'],
        })
        .mockResolvedValueOnce({
          keys: ['api-gateway'],
        });

      const scopes = await store.listScopes('org-001');

      expect(client.listKVSecrets).toHaveBeenCalledWith(
        'test-vault-token',
        'kici/secrets/org-001',
        'secret',
      );
      expect(scopes).toEqual(['cloud/aws-prod', 'databases/postgres', 'services/api-gateway']);
    });

    it('listScopes returns empty array for 404 path', async () => {
      const client = getClient(store);
      client.listKVSecrets.mockRejectedValue(createVaultError(404));

      const scopes = await store.listScopes('org-001');

      expect(scopes).toEqual([]);
    });

    it('listScopes returns empty array for 400 (stale AppRole or invalid path)', async () => {
      const client = getClient(store);
      client.listKVSecrets.mockRejectedValue(createVaultError(400));

      const scopes = await store.listScopes('org-001');

      expect(scopes).toEqual([]);
    });
  });

  describe('with AppRole auth', () => {
    beforeEach(() => {
      config = {
        vaultUrl: 'http://vault:8200',
        authMethod: 'approle',
        roleId: 'test-role-id',
        secretId: 'test-secret-id',
        basePath: 'kici/secrets',
      };
      store = new VaultSecretStore(config, logger);
    });

    it('authenticates with AppRole before reading', async () => {
      const client = getClient(store);
      client.loginWithAppRole.mockResolvedValue({
        client_token: 'dynamic-token-abc',
        lease_duration: 3600,
      });
      client.readKVSecret.mockResolvedValue({
        data: { KEY: 'val' },
        metadata: { version: 1 },
      });

      await store.getSecrets('org-001', 'scope-a');

      expect(client.loginWithAppRole).toHaveBeenCalledWith('test-role-id', 'test-secret-id');
      expect(client.readKVSecret).toHaveBeenCalledWith(
        'dynamic-token-abc',
        'kici/secrets/org-001/scope-a',
        undefined,
        'secret',
      );
    });

    it('re-authenticates on 403 (expired token)', async () => {
      const client = getClient(store);
      client.loginWithAppRole
        .mockResolvedValueOnce({
          client_token: 'token-1',
          lease_duration: 3600,
        })
        .mockResolvedValueOnce({
          client_token: 'token-2',
          lease_duration: 3600,
        });

      client.readKVSecret.mockRejectedValueOnce(createVaultError(403)).mockResolvedValueOnce({
        data: { KEY: 'val' },
        metadata: { version: 1 },
      });

      const result = await store.getSecrets('org-001', 'scope-a');

      expect(client.loginWithAppRole).toHaveBeenCalledTimes(2);
      expect(client.readKVSecret).toHaveBeenCalledTimes(2);
      expect(client.readKVSecret).toHaveBeenLastCalledWith(
        'token-2',
        'kici/secrets/org-001/scope-a',
        undefined,
        'secret',
      );
      expect(result).toEqual({ KEY: 'val' });
    });

    it('caches token for subsequent calls', async () => {
      const client = getClient(store);
      client.loginWithAppRole.mockResolvedValue({
        client_token: 'cached-token',
        lease_duration: 3600,
      });
      client.readKVSecret.mockResolvedValue({
        data: { K: 'v' },
        metadata: { version: 1 },
      });

      await store.getSecrets('org-001', 'scope-a');
      await store.getSecrets('org-001', 'scope-b');

      expect(client.loginWithAppRole).toHaveBeenCalledTimes(1);
      expect(client.readKVSecret).toHaveBeenCalledTimes(2);
    });

    it('throws on missing roleId', async () => {
      const badConfig: VaultConfig = {
        vaultUrl: 'http://vault:8200',
        authMethod: 'approle',
        basePath: 'kici/secrets',
      };
      const badStore = new VaultSecretStore(badConfig, logger);

      await expect(badStore.getSecrets('org-001', 'scope')).rejects.toThrow(
        'Vault AppRole auth requires roleId and secretId',
      );
    });
  });

  describe('namespace support', () => {
    it('passes namespace to Vault client config', async () => {
      const Vault = (await import('hashi-vault-js')).default;

      config = {
        vaultUrl: 'https://vault.example.com',
        authMethod: 'token',
        token: 'ns-token',
        namespace: 'engineering/team-a',
        basePath: 'kici/secrets',
      };
      new VaultSecretStore(config, logger);

      expect(Vault).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: 'engineering/team-a',
          https: true,
        }),
      );
    });
  });

  describe('custom mount path', () => {
    it('uses custom mount path for operations', async () => {
      config = {
        vaultUrl: 'http://vault:8200',
        authMethod: 'token',
        token: 'my-token',
        basePath: 'team/secrets',
        mountPath: 'custom-kv',
      };
      store = new VaultSecretStore(config, logger);
      const client = getClient(store);
      client.readKVSecret.mockResolvedValue({
        data: { X: 'y' },
        metadata: { version: 1 },
      });

      await store.getSecrets('org-001', 'custom-scope');

      expect(client.readKVSecret).toHaveBeenCalledWith(
        'my-token',
        'team/secrets/org-001/custom-scope',
        undefined,
        'custom-kv',
      );
    });
  });

  describe('error propagation', () => {
    it('throws non-Vault errors directly', async () => {
      config = {
        vaultUrl: 'http://vault:8200',
        authMethod: 'token',
        token: 'my-token',
        basePath: 'kici/secrets',
      };
      store = new VaultSecretStore(config, logger);
      const client = getClient(store);
      client.readKVSecret.mockRejectedValue(new Error('Network error'));

      await expect(store.getSecrets('org-001', 'scope')).rejects.toThrow('Network error');
    });

    it('throws non-403/non-404 Vault errors', async () => {
      config = {
        vaultUrl: 'http://vault:8200',
        authMethod: 'token',
        token: 'my-token',
        basePath: 'kici/secrets',
      };
      store = new VaultSecretStore(config, logger);
      const client = getClient(store);
      client.readKVSecret.mockRejectedValue(createVaultError(500));

      await expect(store.getSecrets('org-001', 'scope')).rejects.toThrow('Vault error 500');
    });
  });

  describe('request logging', () => {
    beforeEach(() => {
      config = {
        vaultUrl: 'http://vault:8200',
        authMethod: 'token',
        token: 'test-vault-token',
        basePath: 'kici/secrets',
        mountPath: 'secret',
      };
      store = new VaultSecretStore(config, logger);
    });

    it('logs successful getSecrets call at info level', async () => {
      const client = getClient(store);
      client.readKVSecret.mockResolvedValue({
        data: { KEY: 'val' },
        metadata: { version: 1 },
      });

      await store.getSecrets('org-001', 'scope-a');

      expect(logger.info).toHaveBeenCalledWith(
        'Vault request',
        expect.objectContaining({
          operation: 'READ',
          path: 'kici/secrets/org-001/scope-a',
          status: 200,
          mountPath: 'secret',
          authMethod: 'token',
        }),
      );
    });

    it('logs failed getSecrets call at error level with status and error', async () => {
      const client = getClient(store);
      client.readKVSecret.mockRejectedValue(createVaultError(400));

      await store.getSecrets('org-001', 'scope-a').catch(() => {});

      expect(logger.error).toHaveBeenCalledWith(
        'Vault request failed',
        expect.objectContaining({
          operation: 'READ',
          path: 'kici/secrets/org-001/scope-a',
          status: 400,
          error: expect.any(String),
        }),
      );
    });
  });

  describe('withRetry on 400', () => {
    beforeEach(() => {
      config = {
        vaultUrl: 'http://vault:8200',
        authMethod: 'approle',
        roleId: 'test-role-id',
        secretId: 'test-secret-id',
        basePath: 'kici/secrets',
      };
      store = new VaultSecretStore(config, logger);
    });

    it('re-authenticates on 400 (stale auth) same as 403', async () => {
      const client = getClient(store);
      client.loginWithAppRole
        .mockResolvedValueOnce({
          client_token: 'token-1',
          lease_duration: 3600,
        })
        .mockResolvedValueOnce({
          client_token: 'token-2',
          lease_duration: 3600,
        });

      client.readKVSecret.mockRejectedValueOnce(createVaultError(400)).mockResolvedValueOnce({
        data: { KEY: 'val' },
        metadata: { version: 1 },
      });

      const result = await store.getSecrets('org-001', 'scope-a');

      expect(client.loginWithAppRole).toHaveBeenCalledTimes(2);
      expect(client.readKVSecret).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ KEY: 'val' });
    });
  });

  describe('listScopes 400 logging', () => {
    beforeEach(() => {
      config = {
        vaultUrl: 'http://vault:8200',
        authMethod: 'token',
        token: 'test-vault-token',
        basePath: 'kici/secrets',
        mountPath: 'secret',
      };
      store = new VaultSecretStore(config, logger);
    });

    it('logs the error via logVaultRequest before returning empty on 400', async () => {
      const client = getClient(store);
      client.listKVSecrets.mockRejectedValue(createVaultError(400));

      const scopes = await store.listScopes('org-001');

      expect(scopes).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        'Vault request failed',
        expect.objectContaining({
          operation: 'LIST',
          status: 400,
        }),
      );
    });
  });
});
