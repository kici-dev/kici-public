/**
 * Tests for SecretResolver (environment-binding-based resolution).
 *
 * The resolver takes an org + environment name, looks up bindings,
 * matches them against scoped secrets via resolveSecretsForEnvironment,
 * decrypts matching secrets, and returns a flat key-value map.
 *
 * After the multi-backend migration, all scopes and binding patterns are
 * prefixed with the backend name (e.g., 'pg:aws/prod/db', 'pg:aws/**').
 * The resolver collects secrets from ALL backend stores and prefixes each
 * secret's scope with the backend name before matching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SecretResolver } from './secret-resolver.js';
import type { EnvironmentBinding, ScopedSecret } from '@kici-dev/engine';
import type { Logger } from '@kici-dev/shared';
import type { AuditLogger } from './audit-logger.js';

// ── Mock stores ────────────────────────────────────────────────

interface MockEnvironmentStore {
  getByName: ReturnType<typeof vi.fn>;
}

interface MockBindingStore {
  getByEnvironmentId: ReturnType<typeof vi.fn>;
}

interface MockSecretStore {
  getAllSecrets: ReturnType<typeof vi.fn>;
  decrypt: ReturnType<typeof vi.fn>;
}

function makeAuditLogger(): AuditLogger {
  return { log: vi.fn(), query: vi.fn() } as unknown as AuditLogger;
}

function makeBinding(overrides: Partial<EnvironmentBinding> = {}): EnvironmentBinding {
  return {
    id: 'bind-1',
    orgId: 'org-1',
    environmentId: 'env-1',
    scopePattern: 'pg:aws/prod/**',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeScopedSecret(overrides: Partial<ScopedSecret> = {}): ScopedSecret {
  return {
    id: 'sec-1',
    orgId: 'org-1',
    scope: 'aws/prod/db',
    key: 'DB_PASSWORD',
    encryptedValue: 'encrypted:DB_PASSWORD',
    backendType: 'pg',
    keyVersion: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe('SecretResolver', () => {
  let envStore: MockEnvironmentStore;
  let bindingStore: MockBindingStore;
  let secretStore: MockSecretStore;
  let auditLogger: AuditLogger;
  let logger: Logger;

  beforeEach(() => {
    envStore = { getByName: vi.fn() };
    bindingStore = { getByEnvironmentId: vi.fn() };
    secretStore = {
      getAllSecrets: vi.fn(),
      decrypt: vi.fn(),
    };
    auditLogger = makeAuditLogger();
    logger = makeLogger();
  });

  function createResolver(extraBackends?: Map<string, MockSecretStore>) {
    const backendStores = new Map<string, any>([['pg', secretStore]]);
    if (extraBackends) {
      for (const [name, store] of extraBackends) {
        backendStores.set(name, store);
      }
    }
    return new SecretResolver({
      environmentStore: envStore as any,
      bindingStore: bindingStore as any,
      backendStores,
      auditLogger,
      logger,
    });
  }

  it('resolves secrets for environment with matching bindings', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'production', orgId: 'org-1' });
    bindingStore.getByEnvironmentId.mockResolvedValue([
      makeBinding({ scopePattern: 'pg:aws/prod/**' }),
    ]);
    // Secrets are stored WITHOUT prefix; resolver adds 'pg:' prefix
    secretStore.getAllSecrets.mockResolvedValue([
      makeScopedSecret({ scope: 'aws/prod/db', key: 'DB_PASSWORD', encryptedValue: 'enc:dbpw' }),
      makeScopedSecret({
        id: 'sec-2',
        scope: 'aws/prod/api',
        key: 'API_KEY',
        encryptedValue: 'enc:apikey',
      }),
    ]);
    secretStore.decrypt.mockImplementation((s: ScopedSecret) =>
      s.encryptedValue.replace('enc:', ''),
    );

    const resolver = createResolver();
    const result = await resolver.resolveForJob('org-1', 'production');

    expect(result).toEqual({ DB_PASSWORD: 'dbpw', API_KEY: 'apikey' });
  });

  it('returns empty secrets when no environment is found', async () => {
    envStore.getByName.mockResolvedValue(null);

    const resolver = createResolver();
    const result = await resolver.resolveForJob('org-1', 'nonexistent');

    expect(result).toEqual({});
  });

  it('returns empty secrets when environment has no bindings', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'staging', orgId: 'org-1' });
    bindingStore.getByEnvironmentId.mockResolvedValue([]);
    secretStore.getAllSecrets.mockResolvedValue([
      makeScopedSecret({ scope: 'aws/prod/db', key: 'DB_PASSWORD' }),
    ]);

    const resolver = createResolver();
    const result = await resolver.resolveForJob('org-1', 'staging');

    expect(result).toEqual({});
  });

  it('merges with longest-path-wins when multiple bindings match', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'production', orgId: 'org-1' });
    bindingStore.getByEnvironmentId.mockResolvedValue([
      makeBinding({ scopePattern: 'pg:**' }),
      makeBinding({ id: 'bind-2', scopePattern: 'pg:aws/prod/**' }),
    ]);
    // Same key in two scopes -- longer scope path wins (after prefix strip)
    secretStore.getAllSecrets.mockResolvedValue([
      makeScopedSecret({ scope: 'aws/shared', key: 'DB_HOST', encryptedValue: 'enc:shared-host' }),
      makeScopedSecret({
        id: 'sec-2',
        scope: 'aws/prod/db',
        key: 'DB_HOST',
        encryptedValue: 'enc:prod-host',
      }),
    ]);
    secretStore.decrypt.mockImplementation((s: ScopedSecret) =>
      s.encryptedValue.replace('enc:', ''),
    );

    const resolver = createResolver();
    const result = await resolver.resolveForJob('org-1', 'production');

    // aws/prod/db (3 segments) beats aws/shared (2 segments) for DB_HOST
    expect(result).toEqual({ DB_HOST: 'prod-host' });
  });

  it('returns empty when binding patterns do not match any secrets', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'staging', orgId: 'org-1' });
    bindingStore.getByEnvironmentId.mockResolvedValue([
      makeBinding({ scopePattern: 'pg:gcp/staging/**' }),
    ]);
    secretStore.getAllSecrets.mockResolvedValue([
      makeScopedSecret({ scope: 'aws/prod/db', key: 'DB_PASSWORD', encryptedValue: 'enc:dbpw' }),
    ]);

    const resolver = createResolver();
    const result = await resolver.resolveForJob('org-1', 'staging');

    expect(result).toEqual({});
  });

  it('decrypts all matched secrets', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'production', orgId: 'org-1' });
    bindingStore.getByEnvironmentId.mockResolvedValue([
      makeBinding({ scopePattern: 'pg:aws/prod/**' }),
    ]);
    secretStore.getAllSecrets.mockResolvedValue([
      makeScopedSecret({ scope: 'aws/prod/a', key: 'KEY_A', encryptedValue: 'enc:aaa' }),
      makeScopedSecret({
        id: 'sec-2',
        scope: 'aws/prod/b',
        key: 'KEY_B',
        encryptedValue: 'enc:bbb',
      }),
      makeScopedSecret({
        id: 'sec-3',
        scope: 'aws/prod/c',
        key: 'KEY_C',
        encryptedValue: 'enc:ccc',
      }),
    ]);
    secretStore.decrypt.mockImplementation((s: ScopedSecret) =>
      s.encryptedValue.replace('enc:', ''),
    );

    const resolver = createResolver();
    const result = await resolver.resolveForJob('org-1', 'production');

    expect(result).toEqual({ KEY_A: 'aaa', KEY_B: 'bbb', KEY_C: 'ccc' });
    expect(secretStore.decrypt).toHaveBeenCalledTimes(3);
  });

  it('throws when a referenced backend store is unreachable', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'production', orgId: 'org-1' });
    bindingStore.getByEnvironmentId.mockResolvedValue([makeBinding({ scopePattern: 'pg:**' })]);
    secretStore.getAllSecrets.mockRejectedValue(new Error('Connection refused'));

    const resolver = createResolver();
    await expect(resolver.resolveForJob('org-1', 'production')).rejects.toThrow(
      /Secret backend 'pg' is unreachable.*Connection refused/,
    );
  });

  it('succeeds when unreferenced vault backend is down but PG bindings are satisfied', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'production', orgId: 'org-1' });
    // Binding only references pg secrets
    bindingStore.getByEnvironmentId.mockResolvedValue([
      makeBinding({ scopePattern: 'pg:aws/prod/**' }),
    ]);

    // PG backend has matching secrets
    secretStore.getAllSecrets.mockResolvedValue([
      makeScopedSecret({ scope: 'aws/prod/db', key: 'DB_PASSWORD', encryptedValue: 'enc:pw' }),
    ]);
    secretStore.decrypt.mockImplementation((s: ScopedSecret) =>
      s.encryptedValue.replace('enc:', ''),
    );

    // Vault backend is unreachable — but binding doesn't reference it
    const vaultStore: MockSecretStore = {
      getAllSecrets: vi.fn().mockRejectedValue(new Error('Vault sealed')),
      decrypt: vi.fn(),
    };

    const resolver = createResolver(new Map([['vault-prod', vaultStore]]));
    const result = await resolver.resolveForJob('org-1', 'production');

    // Should succeed — vault-prod being down doesn't affect pg-only bindings
    expect(result).toEqual({ DB_PASSWORD: 'pw' });
    // Warning should be logged
    expect(logger.warn).toHaveBeenCalledWith(
      'Secret backends unreachable during collection',
      expect.objectContaining({
        failedBackends: { 'vault-prod': 'Vault sealed' },
      }),
    );
  });

  it('fails when vault backend is down and binding could match it', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'production', orgId: 'org-1' });
    // Binding explicitly references vault-prod
    bindingStore.getByEnvironmentId.mockResolvedValue([
      makeBinding({ scopePattern: 'vault-prod:**' }),
    ]);

    // PG backend has secrets (but doesn't match vault-prod: prefix)
    secretStore.getAllSecrets.mockResolvedValue([
      makeScopedSecret({ scope: 'aws/prod/db', key: 'DB_PASSWORD', encryptedValue: 'enc:pw' }),
    ]);

    // Vault backend is unreachable
    const vaultStore: MockSecretStore = {
      getAllSecrets: vi.fn().mockRejectedValue(new Error('Connection refused')),
      decrypt: vi.fn(),
    };

    const resolver = createResolver(new Map([['vault-prod', vaultStore]]));
    await expect(resolver.resolveForJob('org-1', 'production')).rejects.toThrow(
      /Secret backend 'vault-prod' is unreachable.*Connection refused/,
    );
  });

  it('resolveForJobWithMeta also applies scoped failure logic', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'production', orgId: 'org-1' });
    bindingStore.getByEnvironmentId.mockResolvedValue([
      makeBinding({ scopePattern: 'vault-prod:**' }),
    ]);

    secretStore.getAllSecrets.mockResolvedValue([]);

    const vaultStore: MockSecretStore = {
      getAllSecrets: vi.fn().mockRejectedValue(new Error('Vault unreachable')),
      decrypt: vi.fn(),
    };

    const resolver = createResolver(new Map([['vault-prod', vaultStore]]));
    await expect(resolver.resolveForJobWithMeta('org-1', 'production')).rejects.toThrow(
      /Secret backend 'vault-prod' is unreachable/,
    );
  });

  it('all backends healthy works as before (regression)', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'production', orgId: 'org-1' });
    bindingStore.getByEnvironmentId.mockResolvedValue([
      makeBinding({ scopePattern: 'pg:aws/prod/**' }),
    ]);
    secretStore.getAllSecrets.mockResolvedValue([
      makeScopedSecret({ scope: 'aws/prod/db', key: 'DB_PASSWORD', encryptedValue: 'enc:pw' }),
    ]);
    secretStore.decrypt.mockImplementation((s: ScopedSecret) =>
      s.encryptedValue.replace('enc:', ''),
    );

    const resolver = createResolver();
    const result = await resolver.resolveForJob('org-1', 'production');

    expect(result).toEqual({ DB_PASSWORD: 'pw' });
    // No warning should be logged when all backends are healthy
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('resolves secrets from multiple backends', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'production', orgId: 'org-1' });
    bindingStore.getByEnvironmentId.mockResolvedValue([
      makeBinding({ scopePattern: 'pg:**' }),
      makeBinding({ id: 'bind-2', scopePattern: 'vault-prod:**' }),
    ]);

    // PG backend secrets
    secretStore.getAllSecrets.mockResolvedValue([
      makeScopedSecret({ scope: 'aws/prod', key: 'DB_PASSWORD', encryptedValue: 'enc:pg-pw' }),
    ]);
    secretStore.decrypt.mockImplementation((s: ScopedSecret) =>
      s.encryptedValue.replace('enc:', ''),
    );

    // Vault backend secrets
    const vaultStore: MockSecretStore = {
      getAllSecrets: vi.fn().mockResolvedValue([
        makeScopedSecret({
          scope: 'aws/prod',
          key: 'API_KEY',
          encryptedValue: 'vault-api-key',
          backendType: 'vault',
        }),
      ]),
      decrypt: vi.fn((s: ScopedSecret) => s.encryptedValue), // Vault returns plaintext
    };

    const resolver = createResolver(new Map([['vault-prod', vaultStore]]));
    const result = await resolver.resolveForJob('org-1', 'production');

    expect(result).toEqual({
      DB_PASSWORD: 'pg-pw',
      API_KEY: 'vault-api-key',
    });
  });

  it('audit log only includes backends that contributed resolved secrets', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'production', orgId: 'org-1' });
    // Binding only matches pg secrets (not vault-prod)
    bindingStore.getByEnvironmentId.mockResolvedValue([
      makeBinding({ scopePattern: 'pg:aws/prod/**' }),
    ]);

    // PG backend has matching secrets
    secretStore.getAllSecrets.mockResolvedValue([
      makeScopedSecret({ scope: 'aws/prod/db', key: 'DB_PASSWORD', encryptedValue: 'enc:pw' }),
    ]);
    secretStore.decrypt.mockImplementation((s: ScopedSecret) =>
      s.encryptedValue.replace('enc:', ''),
    );

    // Vault backend has secrets too, but they don't match the binding
    const vaultStore: MockSecretStore = {
      getAllSecrets: vi.fn().mockResolvedValue([
        makeScopedSecret({
          scope: 'gcp/staging',
          key: 'UNRELATED_KEY',
          encryptedValue: 'vault-val',
          backendType: 'vault',
        }),
      ]),
      decrypt: vi.fn((s: ScopedSecret) => s.encryptedValue),
    };

    const resolver = createResolver(new Map([['vault-prod', vaultStore]]));
    await resolver.resolveForJob('org-1', 'production');

    // Audit log should only list 'pg', NOT 'vault-prod'
    const logCall = (auditLogger as any).log.mock.calls[0]?.[0];
    expect(logCall).toBeDefined();
    expect(logCall.metadata.backends).toEqual(['pg']);
  });

  it('resolveForJobWithMeta returns backend metadata per ', async () => {
    envStore.getByName.mockResolvedValue({ id: 'env-1', name: 'production', orgId: 'org-1' });
    bindingStore.getByEnvironmentId.mockResolvedValue([makeBinding({ scopePattern: 'pg:**' })]);
    secretStore.getAllSecrets.mockResolvedValue([
      makeScopedSecret({ scope: 'aws/prod', key: 'DB_PASSWORD', encryptedValue: 'enc:pw' }),
    ]);
    secretStore.decrypt.mockImplementation((s: ScopedSecret) =>
      s.encryptedValue.replace('enc:', ''),
    );

    const resolver = createResolver();
    const result = await resolver.resolveForJobWithMeta('org-1', 'production');

    expect(result.DB_PASSWORD).toBeDefined();
    expect(result.DB_PASSWORD.value).toBe('pw');
    expect(result.DB_PASSWORD.backend).toBe('pg');
    expect(result.DB_PASSWORD.scope).toBe('pg:aws/prod');
  });

  // ── resolveNamed (source-scoped direct lookup) ────────────────

  describe('resolveNamed', () => {
    it('returns a named secret by (scope, key) from the default backend', async () => {
      (secretStore as any).getSecrets = vi
        .fn()
        .mockResolvedValue({ 'forgejo-pat': 'hunter2', 'other-key': 'zzz' });

      const resolver = createResolver();
      const result = await resolver.resolveNamed('org-1', '__source__/src-123', 'forgejo-pat');

      expect(result).toBe('hunter2');
      expect((secretStore as any).getSecrets).toHaveBeenCalledWith('org-1', '__source__/src-123');
    });

    it('returns null when the key is not present in any backend', async () => {
      (secretStore as any).getSecrets = vi.fn().mockResolvedValue({ 'other-key': 'zzz' });

      const resolver = createResolver();
      const result = await resolver.resolveNamed('org-1', '__source__/src-123', 'missing-key');

      expect(result).toBeNull();
    });

    it('restricts lookup to an explicit backend', async () => {
      (secretStore as any).getSecrets = vi.fn().mockResolvedValue({ 'forgejo-pat': 'pg-value' });
      const vault: any = {
        getAllSecrets: vi.fn(),
        decrypt: vi.fn(),
        getSecrets: vi.fn().mockResolvedValue({ 'forgejo-pat': 'vault-value' }),
      };
      const extra = new Map<string, any>([['vault-prod', vault]]);

      const resolver = createResolver(extra);
      const result = await resolver.resolveNamed('org-1', '__source__/src-123', 'forgejo-pat', {
        store: 'vault-prod',
      });

      expect(result).toBe('vault-value');
      expect(vault.getSecrets).toHaveBeenCalledWith('org-1', '__source__/src-123');
      // PG store must not be touched when explicit backend is requested
      expect((secretStore as any).getSecrets).not.toHaveBeenCalled();
    });

    it('throws when explicit backend is missing', async () => {
      const resolver = createResolver();
      await expect(
        resolver.resolveNamed('org-1', '__source__/src-123', 'k', { store: 'missing-backend' }),
      ).rejects.toThrow(/not registered/);
    });

    it('falls through to next backend when the first is unreachable', async () => {
      (secretStore as any).getSecrets = vi.fn().mockRejectedValue(new Error('pg is down'));
      const vault: any = {
        getAllSecrets: vi.fn(),
        decrypt: vi.fn(),
        getSecrets: vi.fn().mockResolvedValue({ 'forgejo-pat': 'vault-value' }),
      };
      const extra = new Map<string, any>([['vault-prod', vault]]);

      const resolver = createResolver(extra);
      const result = await resolver.resolveNamed('org-1', '__source__/src-123', 'forgejo-pat');

      expect(result).toBe('vault-value');
      expect(logger.warn).toHaveBeenCalled();
    });

    it('writes a resolve_named audit entry on success', async () => {
      (secretStore as any).getSecrets = vi.fn().mockResolvedValue({ 'forgejo-pat': 'hunter2' });

      const resolver = createResolver();
      await resolver.resolveNamed('org-1', '__source__/src-123', 'forgejo-pat');

      const logCall = (auditLogger as any).log.mock.calls[0]?.[0];
      expect(logCall).toBeDefined();
      expect(logCall.action).toBe('resolve_named');
      expect(logCall.contextName).toBe('__source__/src-123');
      expect(logCall.secretKeys).toEqual(['forgejo-pat']);
      expect(logCall.outcome).toBe('allowed');
      expect(logCall.metadata.backend).toBe('pg');
    });
  });
});
