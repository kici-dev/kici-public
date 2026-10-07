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

  describe('default bundle fallback', () => {
    it('getByRoutingKey falls back to the type default bundle', () => {
      const registry = new ProviderRegistry();
      const bundle = createMockBundle();
      registry.register('github', bundle);
      expect(registry.getByRoutingKey('github:12345')).toBe(bundle);
    });

    it('never falls back to another App bundle for an unknown github key', () => {
      // fails-when: the type-prefix scan returns github:1's bundle for github:2.
      const registry = new ProviderRegistry();
      registry.registerByRoutingKey('github:1', createMockBundle());
      expect(registry.getByRoutingKey('github:2')).toBeUndefined();
    });

    it('resolves a generic routing key through the generic default bundle', () => {
      // breaks-if-wrong: the live generic fallback (orchestrator-core registers generic) must survive.
      const registry = new ProviderRegistry();
      const bundle = createMockBundle();
      registry.register('generic', bundle);
      expect(registry.getByRoutingKey('generic:abc:src')).toBe(bundle);
    });

    it('never falls back to another source bundle for an unknown generic key', () => {
      // A `generic:{orgId}:{sourceId}` key is fully qualified, so the
      // type-prefix scan cannot mean "the single configured app" the way it
      // does for `github:`. Handing back whichever generic bundle happens to
      // be first in insertion order crosses sources — and, as below, orgs.
      const registry = new ProviderRegistry();
      const otherOrgBundle = createMockBundle();
      registry.registerByRoutingKey('generic:org-a:source-1', otherOrgBundle);

      expect(registry.getByRoutingKey('generic:org-b:source-2')).toBeUndefined();
    });

    it('falls back to the shared default bundle for an unknown generic key', () => {
      // The one legitimate stand-in: a plain generic source has no
      // per-routing-key bundle by design and is meant to use this one.
      const registry = new ProviderRegistry();
      const defaultBundle = createMockBundle();
      registry.register('generic', defaultBundle);
      registry.registerByRoutingKey('generic:org-a:source-1', createMockBundle());

      expect(registry.getByRoutingKey('generic:org-b:source-2')).toBe(defaultBundle);
    });
  });

  describe('hasExact', () => {
    it('distinguishes a registered key from one only the fallback can answer', () => {
      const registry = new ProviderRegistry();
      registry.register('generic', createMockBundle());
      registry.registerByRoutingKey('generic:org-a:source-1', createMockBundle());

      expect(registry.hasExact('generic:org-a:source-1')).toBe(true);
      // getByRoutingKey answers this one from the default bundle, so only
      // hasExact can tell a caller the source's own bundle is missing.
      expect(registry.hasExact('generic:org-b:source-2')).toBe(false);
      expect(registry.getByRoutingKey('generic:org-b:source-2')).toBeDefined();
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
