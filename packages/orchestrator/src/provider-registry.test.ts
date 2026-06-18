import { describe, it, expect, vi } from 'vitest';
import { ProviderRegistry, type ProviderBundle } from './provider-registry.js';

function createMockBundle(overrides?: Partial<ProviderBundle>): ProviderBundle {
  return {
    normalizer: {
      provider: 'github' as const,
      extractRoutingKey: vi.fn(),
      extractDeliveryId: vi.fn(),
      extractEventType: vi.fn(),
      verifySignature: vi.fn(),
      normalizeEvent: vi.fn(),
    },
    lockFileFetcher: {
      provider: 'github' as const,
      fetchLockFile: vi.fn(),
    },
    changedFilesFetcher: {
      provider: 'github' as const,
      getChangedFiles: vi.fn(),
    },
    cloneTokenProvider: {
      provider: 'github' as const,
      createCloneToken: vi.fn(),
    },
    repoUrlBuilder: {
      provider: 'github' as const,
      buildCloneUrl: vi.fn(),
      buildRawFileUrl: vi.fn(),
    },
    ...overrides,
  };
}

describe('ProviderRegistry', () => {
  describe('registerByRoutingKey / getByRoutingKey', () => {
    it('stores and retrieves bundles by routing key', () => {
      const registry = new ProviderRegistry();
      const bundle = createMockBundle();
      registry.registerByRoutingKey('github:12345', bundle);

      expect(registry.getByRoutingKey('github:12345')).toBe(bundle);
    });

    it('supports multiple apps for the same provider type', () => {
      const registry = new ProviderRegistry();
      const bundle1 = createMockBundle();
      const bundle2 = createMockBundle();

      registry.registerByRoutingKey('github:12345', bundle1);
      registry.registerByRoutingKey('github:67890', bundle2);

      expect(registry.getByRoutingKey('github:12345')).toBe(bundle1);
      expect(registry.getByRoutingKey('github:67890')).toBe(bundle2);
    });

    it('returns undefined for unknown routing key', () => {
      const registry = new ProviderRegistry();
      expect(registry.getByRoutingKey('github:99999')).toBeUndefined();
    });
  });

  describe('backward-compatible register / get', () => {
    it('register(type) stores under synthetic default key', () => {
      const registry = new ProviderRegistry();
      const bundle = createMockBundle();

      registry.register('github', bundle);

      // Accessible via get(type)
      expect(registry.get('github')).toBe(bundle);
    });

    it('get(type) returns first matching bundle when no default', () => {
      const registry = new ProviderRegistry();
      const bundle = createMockBundle();

      registry.registerByRoutingKey('github:12345', bundle);

      // get('github') should find it via prefix scan
      expect(registry.get('github')).toBe(bundle);
    });

    it('get(type) prefers default key over routing-key bundles', () => {
      const registry = new ProviderRegistry();
      const defaultBundle = createMockBundle();
      const appBundle = createMockBundle();

      registry.register('github', defaultBundle);
      registry.registerByRoutingKey('github:12345', appBundle);

      expect(registry.get('github')).toBe(defaultBundle);
    });

    it('getByRoutingKey falls back to type lookup for backward compat', () => {
      const registry = new ProviderRegistry();
      const bundle = createMockBundle();

      // Registered via old API
      registry.register('github', bundle);

      // getByRoutingKey should find it via fallback
      expect(registry.getByRoutingKey('github:12345')).toBe(bundle);
    });
  });

  describe('has', () => {
    it('returns true when provider has default registration', () => {
      const registry = new ProviderRegistry();
      registry.register('github', createMockBundle());

      expect(registry.has('github')).toBe(true);
    });

    it('returns true when provider has routing-key registration', () => {
      const registry = new ProviderRegistry();
      registry.registerByRoutingKey('github:12345', createMockBundle());

      expect(registry.has('github')).toBe(true);
    });

    it('returns false when provider is not registered', () => {
      const registry = new ProviderRegistry();
      expect(registry.has('github')).toBe(false);
    });
  });

  describe('getRoutingKeys', () => {
    it('returns all registered routing keys', () => {
      const registry = new ProviderRegistry();
      registry.registerByRoutingKey('github:12345', createMockBundle());
      registry.registerByRoutingKey('github:67890', createMockBundle());

      const keys = registry.getRoutingKeys();
      expect(keys).toContain('github:12345');
      expect(keys).toContain('github:67890');
      expect(keys).toHaveLength(2);
    });

    it('includes synthetic default keys from register(type)', () => {
      const registry = new ProviderRegistry();
      registry.register('github', createMockBundle());

      expect(registry.getRoutingKeys()).toEqual(['github:default']);
    });

    it('returns empty array when empty', () => {
      const registry = new ProviderRegistry();
      expect(registry.getRoutingKeys()).toEqual([]);
    });
  });

  describe('getRoutingKeysForProvider', () => {
    it('returns only keys matching provider type', () => {
      const registry = new ProviderRegistry();
      registry.registerByRoutingKey('github:12345', createMockBundle());
      registry.registerByRoutingKey('github:67890', createMockBundle());
      registry.registerByRoutingKey('gitlab:111', createMockBundle());

      const githubKeys = registry.getRoutingKeysForProvider('github');
      expect(githubKeys).toContain('github:12345');
      expect(githubKeys).toContain('github:67890');
      expect(githubKeys).toHaveLength(2);

      const gitlabKeys = registry.getRoutingKeysForProvider('gitlab');
      expect(gitlabKeys).toEqual(['gitlab:111']);
    });
  });

  describe('unregister', () => {
    it('removes a routing key', () => {
      const registry = new ProviderRegistry();
      registry.registerByRoutingKey('github:12345', createMockBundle());

      expect(registry.unregister('github:12345')).toBe(true);
      expect(registry.getByRoutingKey('github:12345')).toBeUndefined();
    });

    it('returns false for non-existent key', () => {
      const registry = new ProviderRegistry();
      expect(registry.unregister('github:99999')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all bundles', () => {
      const registry = new ProviderRegistry();
      registry.registerByRoutingKey('github:12345', createMockBundle());
      registry.registerByRoutingKey('github:67890', createMockBundle());

      registry.clear();

      expect(registry.getRoutingKeys()).toEqual([]);
      expect(registry.getByRoutingKey('github:12345')).toBeUndefined();
    });
  });

  describe('getNormalizerByRoutingKey', () => {
    it('returns the normalizer from the bundle', () => {
      const registry = new ProviderRegistry();
      const bundle = createMockBundle();
      registry.registerByRoutingKey('github:12345', bundle);

      expect(registry.getNormalizerByRoutingKey('github:12345')).toBe(bundle.normalizer);
    });

    it('returns undefined for unknown routing key', () => {
      const registry = new ProviderRegistry();
      expect(registry.getNormalizerByRoutingKey('github:99999')).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('iterates over all bundles', () => {
      const registry = new ProviderRegistry();
      const bundle1 = createMockBundle();
      const bundle2 = createMockBundle();
      registry.registerByRoutingKey('github:12345', bundle1);
      registry.registerByRoutingKey('github:67890', bundle2);

      const entries = [...registry.getAll()];
      expect(entries).toHaveLength(2);
      expect(entries).toContainEqual(['github:12345', bundle1]);
      expect(entries).toContainEqual(['github:67890', bundle2]);
    });
  });
});
