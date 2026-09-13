import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GenericSourceManager, loadActiveGenericRoutingKeys } from './generic-sources.js';
import type { GenericWebhookSource } from '../db/types.js';
import { ProviderRegistry } from '../provider-registry.js';

// -------------------------------------------------------------------
// Kysely mock helpers
//
// NOTE: This test uses a specialized stateful mock (with per-call result
// overrides via _chainFactory) instead of the shared createMockDb() from
// '../__test-helpers__/mock-db.js' because GenericSourceManager tests
// need dynamic per-call result switching (e.g., checkIdempotency).
// -------------------------------------------------------------------

function createMockDb() {
  const mockSource: GenericWebhookSource = {
    id: 'src-123',
    customer_id: 'cust-1',
    name: 'deploy-webhook',
    routing_key: 'generic:cust-1:src-123',
    verification_method: 'hmac_sha256',
    verification_config: '{"secret":"test-secret"}',
    event_type_header: 'X-Event-Type',
    event_type_path: null,
    idempotency_key_header: null,
    idempotency_key_path: null,
    dedup_window_seconds: 300,
    max_payload_bytes: 1048576,
    allowed_events: null,
    strip_headers:
      '["authorization","cookie","set-cookie","proxy-authorization","x-api-key","x-auth-token"]',
    enabled: true,
    rate_limit_rpm: 600,
    created_at: new Date('2026-02-22T00:00:00Z'),
    updated_at: new Date('2026-02-22T00:00:00Z'),
    deleted_at: null,
  };

  // Build a chainable mock that simulates Kysely query builder
  const createChainableQuery = (result: any = undefined) => {
    const chain: any = {};
    const methods = [
      'selectFrom',
      'insertInto',
      'updateTable',
      'deleteFrom',
      'selectAll',
      'select',
      'where',
      'values',
      'set',
      'returningAll',
      'orderBy',
    ];
    for (const method of methods) {
      chain[method] = vi.fn().mockReturnValue(chain);
    }
    chain.executeTakeFirst = vi.fn().mockResolvedValue(result);
    chain.executeTakeFirstOrThrow = vi.fn().mockResolvedValue(result);
    chain.execute = vi.fn().mockResolvedValue(result !== undefined ? [result] : []);
    return chain;
  };

  const db: any = {
    _mockSource: mockSource,
    _chainFactory: createChainableQuery,
    selectFrom: vi.fn(),
    insertInto: vi.fn(),
    updateTable: vi.fn(),
    deleteFrom: vi.fn(),
  };

  // Wire up the default behavior: return the mock source
  db.selectFrom.mockImplementation(() => createChainableQuery(mockSource));
  db.insertInto.mockImplementation(() => createChainableQuery(mockSource));
  db.updateTable.mockImplementation(() => createChainableQuery(mockSource));
  db.deleteFrom.mockImplementation(() => createChainableQuery());

  return db;
}

describe('GenericSourceManager', () => {
  let db: any;
  let manager: GenericSourceManager;

  beforeEach(() => {
    db = createMockDb();
    manager = new GenericSourceManager(db);
  });

  describe('create', () => {
    it('inserts a new source and returns the result', async () => {
      const result = await manager.create({
        orgId: 'cust-1',
        name: 'deploy-webhook',
        verificationMethod: 'hmac_sha256',
        verificationConfig: { secret: 'test-secret' },
      });

      expect(db.insertInto).toHaveBeenCalledWith('generic_webhook_sources');
      expect(result).toBeDefined();
      expect(result.customer_id).toBe('cust-1');
      expect(result.name).toBe('deploy-webhook');
    });

    it('generates routing key in format generic:<orgId>:<id>', async () => {
      // We can't predict the UUID, but we can verify the insertInto chain was called
      const result = await manager.create({
        orgId: 'cust-abc',
        name: 'my-source',
      });

      expect(db.insertInto).toHaveBeenCalledWith('generic_webhook_sources');
      // The insert values should contain a routing_key starting with 'generic:cust-abc:'
      const insertChain = db.insertInto.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.routing_key).toMatch(/^generic:cust-abc:/);
    });

    it('uses defaults for optional fields', async () => {
      await manager.create({
        orgId: 'cust-1',
        name: 'minimal-source',
      });

      const insertChain = db.insertInto.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.verification_method).toBe('hmac_sha256');
      expect(valuesCall.dedup_window_seconds).toBe(300);
      expect(valuesCall.max_payload_bytes).toBe(1048576);
      expect(valuesCall.rate_limit_rpm).toBe(600);
      expect(valuesCall.enabled).toBe(true);
      expect(valuesCall.git_config).toBeNull();
    });

    it('stores validated gitConfig as JSON string when provided', async () => {
      await manager.create({
        orgId: 'cust-1',
        name: 'forgejo-source',
        gitConfig: {
          preset: 'forgejo',
          gitUrlTemplate: 'https://forgejo.example.com/{owner}/{name}.git',
          credentialRef: { key: 'forgejo-pat' },
          credentialType: 'pat',
          sshHostKeyPolicy: 'accept-new',
        },
      });

      const insertChain = db.insertInto.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(typeof valuesCall.git_config).toBe('string');
      const parsed = JSON.parse(valuesCall.git_config);
      expect(parsed.preset).toBe('forgejo');
      expect(parsed.credentialRef.key).toBe('forgejo-pat');
    });

    it('rejects invalid gitConfig before touching the DB', async () => {
      await expect(
        manager.create({
          orgId: 'cust-1',
          name: 'bad-source',
          gitConfig: {
            preset: 'forgejo',
            // Missing gitUrlTemplate, credentialRef, credentialType.
          } as any,
        }),
      ).rejects.toThrow();
      expect(db.insertInto).not.toHaveBeenCalled();
    });

    // Phase 5 — admin-API sanitation contract.
    //
    // The universal-git schema intentionally has NO field for inline secret
    // material (no `password`, `token`, `privateKey`, `pem`). The only secret
    // reference is `credentialRef.{key, store}` — a *name*, never a value.
    // This test locks that contract: if someone ever adds a secret-carrying
    // field to UniversalGitConfigSchema, this test is the tripwire.
    it('stored gitConfig carries only a credential REFERENCE, never the secret value', async () => {
      await manager.create({
        orgId: 'cust-1',
        name: 'forgejo-with-ref-only',
        gitConfig: {
          preset: 'forgejo',
          gitUrlTemplate: 'https://forgejo.example.com/{owner}/{name}.git',
          credentialRef: { key: 'forgejo-pat', store: 'pg' },
          credentialType: 'pat',
          sshHostKeyPolicy: 'accept-new',
        },
      });

      const insertChain = db.insertInto.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      const stored = JSON.parse(valuesCall.git_config);

      // Reference-only credential shape.
      expect(stored.credentialRef).toEqual({ key: 'forgejo-pat', store: 'pg' });
      expect(stored.credentialRef).not.toHaveProperty('secret');
      expect(stored.credentialRef).not.toHaveProperty('value');
      expect(stored.credentialRef).not.toHaveProperty('password');
      expect(stored.credentialRef).not.toHaveProperty('token');

      // No secret fields at the top level either — a grep-style safety net.
      const serialized = JSON.stringify(stored);
      expect(serialized).not.toMatch(/"password"\s*:/i);
      expect(serialized).not.toMatch(/"token"\s*:/i);
      expect(serialized).not.toMatch(/"privatekey"\s*:/i);
      expect(serialized).not.toMatch(/"secret"\s*:/i);
    });

    it('rejects pinned ssh policy without sshKnownHostsPem', async () => {
      await expect(
        manager.create({
          orgId: 'cust-1',
          name: 'bad-ssh',
          gitConfig: {
            preset: 'forgejo',
            gitUrlTemplate: 'git@forgejo.example.com:{owner}/{name}.git',
            credentialRef: { key: 'deploy-key' },
            credentialType: 'ssh',
            sshHostKeyPolicy: 'pinned',
            // sshKnownHostsPem missing.
          } as any,
        }),
      ).rejects.toThrow(/sshKnownHostsPem/);
      expect(db.insertInto).not.toHaveBeenCalled();
    });
  });

  describe('update with gitConfig', () => {
    it('serializes a new gitConfig to JSON', async () => {
      await manager.update('src-123', {
        gitConfig: {
          preset: 'gitea',
          gitUrlTemplate: 'https://gitea.example.com/{owner}/{name}.git',
          credentialRef: { key: 'gitea-pat' },
          credentialType: 'pat',
          sshHostKeyPolicy: 'accept-new',
        },
      });

      const updateChain = db.updateTable.mock.results[0].value;
      const setCall = updateChain.set.mock.calls[0][0];
      expect(typeof setCall.git_config).toBe('string');
      expect(JSON.parse(setCall.git_config).preset).toBe('gitea');
    });

    it('clears gitConfig when passed null', async () => {
      await manager.update('src-123', { gitConfig: null });
      const updateChain = db.updateTable.mock.results[0].value;
      const setCall = updateChain.set.mock.calls[0][0];
      expect(setCall.git_config).toBeNull();
    });

    it('leaves gitConfig untouched when the field is omitted', async () => {
      await manager.update('src-123', { name: 'renamed' });
      const updateChain = db.updateTable.mock.results[0].value;
      const setCall = updateChain.set.mock.calls[0][0];
      expect('git_config' in setCall).toBe(false);
    });
  });

  describe('update with localConfig', () => {
    it('serializes localConfig to git_config and promotes provider_type=local', async () => {
      await manager.update('src-123', {
        localConfig: { repoBasePath: '/srv/kici/policy-repo' },
      });

      const updateChain = db.updateTable.mock.results[0].value;
      const setCall = updateChain.set.mock.calls[0][0];
      expect(typeof setCall.git_config).toBe('string');
      expect(JSON.parse(setCall.git_config).repoBasePath).toBe('/srv/kici/policy-repo');
      // Promoting a carried-over source (e.g. an older provider_type) to a local
      // source must flip provider_type so the local bundle serves it.
      expect(setCall.provider_type).toBe('local');
    });

    it('clears localConfig (git_config) and does not set provider_type when passed null', async () => {
      await manager.update('src-123', { localConfig: null });
      const updateChain = db.updateTable.mock.results[0].value;
      const setCall = updateChain.set.mock.calls[0][0];
      expect(setCall.git_config).toBeNull();
      expect('provider_type' in setCall).toBe(false);
    });
  });

  describe('getById', () => {
    it('returns source when found and not deleted', async () => {
      const result = await manager.getById('src-123');

      expect(db.selectFrom).toHaveBeenCalledWith('generic_webhook_sources');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('src-123');
    });

    it('returns null when source not found', async () => {
      db.selectFrom.mockImplementation(() => db._chainFactory(undefined));

      const result = await manager.getById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getByRoutingKey', () => {
    it('returns source when enabled and not deleted', async () => {
      const result = await manager.getByRoutingKey('generic:cust-1:src-123');

      expect(db.selectFrom).toHaveBeenCalledWith('generic_webhook_sources');
      expect(result).not.toBeNull();
      expect(result!.routing_key).toBe('generic:cust-1:src-123');
    });

    it('returns null for disabled source', async () => {
      db.selectFrom.mockImplementation(() => db._chainFactory(undefined));

      const result = await manager.getByRoutingKey('generic:cust-1:disabled');
      expect(result).toBeNull();
    });

    it('returns null for deleted source', async () => {
      db.selectFrom.mockImplementation(() => db._chainFactory(undefined));

      const result = await manager.getByRoutingKey('generic:cust-1:deleted');
      expect(result).toBeNull();
    });
  });

  describe('getByOrgAndName', () => {
    it('returns source matching customer and name', async () => {
      const result = await manager.getByOrgAndName('cust-1', 'deploy-webhook');

      expect(db.selectFrom).toHaveBeenCalledWith('generic_webhook_sources');
      expect(result).not.toBeNull();
    });
  });

  describe('list', () => {
    it('lists sources for a customer', async () => {
      const result = await manager.list('cust-1');

      expect(db.selectFrom).toHaveBeenCalledWith('generic_webhook_sources');
      expect(result).toBeDefined();
    });
  });

  describe('listByProviderType', () => {
    it('lists local-provider sources only', async () => {
      // Mock returns the canonical mock source as a "row"; the assertion
      // verifies the where clauses get applied with provider_type='local'.
      const result = await manager.listByProviderType('local');

      expect(db.selectFrom).toHaveBeenCalledWith('generic_webhook_sources');
      expect(result).toBeDefined();
      // Verify provider_type, enabled, and deleted_at filters were applied
      const selectChain = db.selectFrom.mock.results[0].value;
      const whereCalls = selectChain.where.mock.calls;
      const hasProviderTypeFilter = whereCalls.some(
        (call: any[]) => call[0] === 'provider_type' && call[1] === '=' && call[2] === 'local',
      );
      const hasEnabledFilter = whereCalls.some(
        (call: any[]) => call[0] === 'enabled' && call[1] === '=' && call[2] === true,
      );
      const hasDeletedFilter = whereCalls.some(
        (call: any[]) => call[0] === 'deleted_at' && call[1] === 'is' && call[2] === null,
      );
      expect(hasProviderTypeFilter).toBe(true);
      expect(hasEnabledFilter).toBe(true);
      expect(hasDeletedFilter).toBe(true);
    });

    it('lists generic-provider sources only', async () => {
      const result = await manager.listByProviderType('generic');
      expect(result).toBeDefined();
      const selectChain = db.selectFrom.mock.results[0].value;
      const whereCalls = selectChain.where.mock.calls;
      const hasProviderTypeFilter = whereCalls.some(
        (call: any[]) => call[0] === 'provider_type' && call[1] === '=' && call[2] === 'generic',
      );
      expect(hasProviderTypeFilter).toBe(true);
    });
  });

  describe('listLocalSources', () => {
    it('filters provider_type=local, enabled, not deleted', async () => {
      const result = await manager.listLocalSources();
      expect(db.selectFrom).toHaveBeenCalledWith('generic_webhook_sources');
      expect(result).toBeDefined();
      const selectChain = db.selectFrom.mock.results[0].value;
      const whereCalls = selectChain.where.mock.calls;
      expect(
        whereCalls.some(
          (call: any[]) => call[0] === 'provider_type' && call[1] === '=' && call[2] === 'local',
        ),
      ).toBe(true);
      expect(
        whereCalls.some(
          (call: any[]) => call[0] === 'enabled' && call[1] === '=' && call[2] === true,
        ),
      ).toBe(true);
      expect(
        whereCalls.some(
          (call: any[]) => call[0] === 'deleted_at' && call[1] === 'is' && call[2] === null,
        ),
      ).toBe(true);
    });
  });

  describe('listUniversalGitSources', () => {
    it('excludes local sources (provider_type != local) so dual-purpose git_config does not misroute', async () => {
      await manager.listUniversalGitSources();
      const selectChain = db.selectFrom.mock.results[0].value;
      const whereCalls = selectChain.where.mock.calls;
      // git_config IS NOT NULL ...
      expect(
        whereCalls.some((call: any[]) => call[0] === 'git_config' && call[1] === 'is not'),
      ).toBe(true);
      // ... AND provider_type != 'local'
      expect(
        whereCalls.some(
          (call: any[]) => call[0] === 'provider_type' && call[1] === '!=' && call[2] === 'local',
        ),
      ).toBe(true);
    });
  });

  describe('create with providerType', () => {
    it('passes provider_type=local when providerType is local', async () => {
      await manager.create({
        orgId: 'cust-1',
        name: 'local-source',
        providerType: 'local',
      });

      const insertChain = db.insertInto.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.provider_type).toBe('local');
    });

    it('defaults provider_type to generic when not specified', async () => {
      await manager.create({
        orgId: 'cust-1',
        name: 'default-source',
      });

      const insertChain = db.insertInto.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.provider_type).toBe('generic');
    });

    it('stores localConfig in git_config for a local source', async () => {
      await manager.create({
        orgId: 'cust-1',
        name: 'policy-repo',
        providerType: 'local',
        verificationMethod: 'none',
        localConfig: { repoBasePath: '/srv/kici/policy-repo' },
      });

      const insertChain = db.insertInto.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.provider_type).toBe('local');
      expect(JSON.parse(valuesCall.git_config)).toEqual({ repoBasePath: '/srv/kici/policy-repo' });
    });

    it('rejects a local source whose localConfig has a relative repoBasePath', async () => {
      await expect(
        manager.create({
          orgId: 'cust-1',
          name: 'bad-local',
          providerType: 'local',
          localConfig: { repoBasePath: 'relative/path' },
        }),
      ).rejects.toThrow();
    });
  });

  describe('update', () => {
    it('updates source fields', async () => {
      const result = await manager.update('src-123', {
        name: 'renamed-webhook',
        verificationMethod: 'bearer_token',
      });

      expect(db.updateTable).toHaveBeenCalledWith('generic_webhook_sources');
      expect(result).not.toBeNull();
    });

    it('returns existing source when no fields to update', async () => {
      const result = await manager.update('src-123', {});
      // Should call getById instead of updateTable
      expect(result).not.toBeNull();
    });
  });

  describe('softDelete', () => {
    it('sets deleted_at on the source', async () => {
      await manager.softDelete('src-123');
      expect(db.updateTable).toHaveBeenCalledWith('generic_webhook_sources');
    });

    it('makes subsequent getByRoutingKey return null', async () => {
      // After soft delete, the source is no longer returned
      await manager.softDelete('src-123');

      // Simulate the DB now returning null for routing key queries
      db.selectFrom.mockImplementation(() => db._chainFactory(undefined));

      const result = await manager.getByRoutingKey('generic:cust-1:src-123');
      expect(result).toBeNull();
    });
  });

  describe('hardDelete', () => {
    it('deletes the source row', async () => {
      await manager.hardDelete('src-123');
      expect(db.deleteFrom).toHaveBeenCalledWith('generic_webhook_sources');
    });
  });

  describe('enable/disable', () => {
    it('enables a source', async () => {
      await manager.enable('src-123');
      expect(db.updateTable).toHaveBeenCalledWith('generic_webhook_sources');
    });

    it('disables a source', async () => {
      await manager.disable('src-123');
      expect(db.updateTable).toHaveBeenCalledWith('generic_webhook_sources');
    });
  });

  describe('checkIdempotency', () => {
    it('returns false when no duplicate found', async () => {
      // getById returns source, selectFrom kici_events returns undefined
      let callCount = 0;
      db.selectFrom.mockImplementation(() => {
        callCount++;
        // First call: getById (generic_webhook_sources) -> return source
        // Second call: idempotency check (kici_events) -> return undefined
        return db._chainFactory(callCount === 1 ? db._mockSource : undefined);
      });

      const result = await manager.checkIdempotency('src-123', 'idempkey-1');
      expect(result).toBe(false);
    });

    it('returns true when duplicate found within window', async () => {
      let callCount = 0;
      db.selectFrom.mockImplementation(() => {
        callCount++;
        // First call: getById -> source
        // Second call: idempotency check -> found a match
        return db._chainFactory(callCount === 1 ? db._mockSource : { id: 'existing-event' });
      });

      const result = await manager.checkIdempotency('src-123', 'idempkey-dup');
      expect(result).toBe(true);
    });

    it('returns false when source not found', async () => {
      db.selectFrom.mockImplementation(() => db._chainFactory(undefined));

      const result = await manager.checkIdempotency('nonexistent', 'key');
      expect(result).toBe(false);
    });
  });

  describe('markIdempotency', () => {
    it('inserts a __dedup: event into kici_events', async () => {
      // First call: getById returns source
      let selectCallCount = 0;
      db.selectFrom.mockImplementation(() => {
        selectCallCount++;
        return db._chainFactory(selectCallCount === 1 ? db._mockSource : undefined);
      });

      await manager.markIdempotency('src-123', 'idempkey-abc');

      expect(db.insertInto).toHaveBeenCalledWith('kici_events');
      const insertChain = db.insertInto.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      expect(valuesCall.event_name).toBe('__dedup:idempkey-abc');
      expect(valuesCall.source_routing_key).toBe('generic:cust-1:src-123');
      expect(valuesCall.payload).toBe('{}');
      expect(valuesCall.expires_at).toBeInstanceOf(Date);
    });

    it('does nothing when source not found', async () => {
      db.selectFrom.mockImplementation(() => db._chainFactory(undefined));
      db.insertInto.mockClear();

      await manager.markIdempotency('nonexistent', 'key');

      expect(db.insertInto).not.toHaveBeenCalled();
    });

    it('sets expires_at based on source dedup_window_seconds', async () => {
      const customSource = { ...db._mockSource, dedup_window_seconds: 600 };
      db.selectFrom.mockImplementation(() => db._chainFactory(customSource));

      const before = Date.now();
      await manager.markIdempotency('src-123', 'key');
      const after = Date.now();

      const insertChain = db.insertInto.mock.results[0].value;
      const valuesCall = insertChain.values.mock.calls[0][0];
      const expiresAt = valuesCall.expires_at.getTime();

      // expires_at should be ~600 seconds from now
      expect(expiresAt).toBeGreaterThanOrEqual(before + 600 * 1000);
      expect(expiresAt).toBeLessThanOrEqual(after + 600 * 1000);
    });
  });

  describe('checkPayloadSize', () => {
    it('returns allowed=true when payload is within limit', async () => {
      const result = await manager.checkPayloadSize('src-123', 500);
      expect(result.allowed).toBe(true);
      expect(result.maxBytes).toBe(1048576);
    });

    it('returns allowed=false when payload exceeds limit', async () => {
      // Create source with small limit
      db.selectFrom.mockImplementation(() =>
        db._chainFactory({ ...db._mockSource, max_payload_bytes: 100 }),
      );

      const result = await manager.checkPayloadSize('src-123', 500);
      expect(result.allowed).toBe(false);
      expect(result.maxBytes).toBe(100);
    });

    it('returns allowed=false when source not found', async () => {
      db.selectFrom.mockImplementation(() => db._chainFactory(undefined));

      const result = await manager.checkPayloadSize('nonexistent', 100);
      expect(result.allowed).toBe(false);
      expect(result.maxBytes).toBe(0);
    });
  });
});

// -------------------------------------------------------------------
// ProviderRegistry generic routing key tests
// -------------------------------------------------------------------

describe('ProviderRegistry', () => {
  describe('isGenericRoutingKey', () => {
    it('returns true for generic routing keys', () => {
      expect(ProviderRegistry.isGenericRoutingKey('generic:cust-1:src-123')).toBe(true);
      expect(ProviderRegistry.isGenericRoutingKey('generic:abc:xyz')).toBe(true);
    });

    it('returns false for non-generic routing keys', () => {
      expect(ProviderRegistry.isGenericRoutingKey('github:12345')).toBe(false);
      expect(ProviderRegistry.isGenericRoutingKey('gitlab:67890')).toBe(false);
      expect(ProviderRegistry.isGenericRoutingKey('bitbucket:uuid')).toBe(false);
    });
  });

  describe('getByRoutingKey with generic provider', () => {
    it('returns generic bundle when registered by routing key', () => {
      const registry = new ProviderRegistry();
      const mockBundle = {
        normalizer: { provider: 'generic' as const } as any,
      };

      registry.registerByRoutingKey('generic:cust-1:src-123', mockBundle);

      const result = registry.getByRoutingKey('generic:cust-1:src-123');
      expect(result).toBe(mockBundle);
      expect(result!.normalizer.provider).toBe('generic');
    });

    it('returns generic bundle from type fallback', () => {
      const registry = new ProviderRegistry();
      const mockBundle = {
        normalizer: { provider: 'generic' as const } as any,
      };

      registry.register('generic', mockBundle);

      const result = registry.getByRoutingKey('generic:any:source');
      expect(result).toBe(mockBundle);
    });

    it('does not return git methods for generic bundle', () => {
      const registry = new ProviderRegistry();
      const mockBundle = {
        normalizer: { provider: 'generic' as const } as any,
        // No lockFileFetcher, changedFilesFetcher, cloneTokenProvider, repoUrlBuilder
      };

      registry.registerByRoutingKey('generic:cust-1:src-123', mockBundle);

      const result = registry.getByRoutingKey('generic:cust-1:src-123');
      expect(result!.lockFileFetcher).toBeUndefined();
      expect(result!.changedFilesFetcher).toBeUndefined();
      expect(result!.cloneTokenProvider).toBeUndefined();
      expect(result!.repoUrlBuilder).toBeUndefined();
    });
  });
});

describe('loadActiveGenericRoutingKeys', () => {
  it('selects from generic_webhook_sources filtering deleted_at IS NULL', async () => {
    const liveRows = [
      {
        routing_key: 'generic:cust-1:live-1',
        customer_id: 'cust-1',
        provider_type: 'generic',
        name: 'Live one',
        git_config: null,
      },
      {
        routing_key: 'generic:cust-2:live-2',
        customer_id: 'cust-2',
        provider_type: 'local',
        name: 'Internal two',
        git_config: null,
      },
      {
        routing_key: 'generic:cust-3:live-3',
        customer_id: 'cust-3',
        provider_type: 'generic',
        name: 'Universal git three',
        git_config: { preset: 'gitea' },
      },
    ];

    const chain: any = {};
    for (const m of ['selectFrom', 'select', 'where']) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.execute = vi.fn().mockResolvedValue(liveRows);

    const db: any = { selectFrom: vi.fn().mockReturnValue(chain) };

    const result = await loadActiveGenericRoutingKeys(db);

    expect(db.selectFrom).toHaveBeenCalledWith('generic_webhook_sources');
    expect(chain.select).toHaveBeenCalledWith([
      'routing_key',
      'customer_id',
      'provider_type',
      'name',
      'git_config',
    ]);
    expect(chain.where).toHaveBeenCalledWith('deleted_at', 'is', null);
    // Result exposes both `has_git_config` (boolean, for SourceSubtype mapping)
    // and the raw `git_config` (so a local source's per-row repoBasePath can be
    // reachability-checked via canServeGenericProviderType).
    expect(result).toEqual([
      {
        routing_key: 'generic:cust-1:live-1',
        customer_id: 'cust-1',
        provider_type: 'generic',
        name: 'Live one',
        has_git_config: false,
        git_config: null,
      },
      {
        routing_key: 'generic:cust-2:live-2',
        customer_id: 'cust-2',
        provider_type: 'local',
        name: 'Internal two',
        has_git_config: false,
        git_config: null,
      },
      {
        routing_key: 'generic:cust-3:live-3',
        customer_id: 'cust-3',
        provider_type: 'generic',
        name: 'Universal git three',
        has_git_config: true,
        git_config: { preset: 'gitea' },
      },
    ]);
  });

  it('returns an empty array when no active rows exist', async () => {
    const chain: any = {};
    for (const m of ['selectFrom', 'select', 'where']) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.execute = vi.fn().mockResolvedValue([]);
    const db: any = { selectFrom: vi.fn().mockReturnValue(chain) };

    const result = await loadActiveGenericRoutingKeys(db);
    expect(result).toEqual([]);
  });
});

describe('genericProviderTypeToSubtype', () => {
  // Keep the mapping covered by a unit test so any future provider_type
  // additions force a conscious choice for the dashboard subtype.
  it('maps each provider_type / git_config combo to the right SourceSubtype', async () => {
    const { genericProviderTypeToSubtype } = await import('../entry-helpers.js');
    expect(genericProviderTypeToSubtype('generic', { hasGitConfig: false })).toBe(
      'generic_webhook',
    );
    expect(genericProviderTypeToSubtype('generic', { hasGitConfig: true })).toBe('universal_git');
    expect(genericProviderTypeToSubtype('universal-git', { hasGitConfig: false })).toBe(
      'universal_git',
    );
    expect(genericProviderTypeToSubtype('universal-git', { hasGitConfig: true })).toBe(
      'universal_git',
    );
    expect(genericProviderTypeToSubtype('local', { hasGitConfig: false })).toBe('local');
    // A local source ALSO carries git_config (it stores repoBasePath there), so
    // the local branch must win over the hasGitConfig universal-git branch.
    expect(genericProviderTypeToSubtype('local', { hasGitConfig: true })).toBe('local');
    // Unknown provider_type falls back to generic_webhook (won't be served
    // anyway because canServeGenericProviderType returns false, but a
    // sensible default matters if someone widens the gate later).
    expect(genericProviderTypeToSubtype('something-new', { hasGitConfig: false })).toBe(
      'generic_webhook',
    );
  });
});
