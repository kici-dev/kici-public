import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SourceManager } from './source-manager.js';
import type { SourceStore, SourceWithSecrets } from './source-store.js';
import type { Source } from '../db/types.js';

// ── Mock helpers ──────────────────────────────────────────────────

function createMockPoolClient() {
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    _emitNotification: (channel: string, payload?: string) => {
      const notificationListeners = listeners.get('notification') ?? [];
      for (const listener of notificationListeners) {
        listener({ channel, payload });
      }
    },
  };
}

function createMockPool(client: ReturnType<typeof createMockPoolClient>) {
  return {
    connect: vi.fn().mockResolvedValue(client),
  };
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 's1',
    provider: 'github',
    name: 'Test App',
    routing_key: 'github:42',
    config: JSON.stringify({ appId: '42' }),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeSourceWithSecrets(overrides: Partial<SourceWithSecrets> = {}): SourceWithSecrets {
  return {
    ...makeSource(overrides),
    privateKey: 'PEM-KEY-DATA',
    webhookSecret: 'whsec_test',
    ...overrides,
  };
}

function createMockSourceStore(
  sources: Source[] = [],
  secretSources: Map<string, SourceWithSecrets> = new Map(),
) {
  return {
    listSources: vi.fn().mockResolvedValue(sources),
    getSourceWithSecrets: vi.fn().mockImplementation(async (routingKey: string) => {
      return secretSources.get(routingKey) ?? null;
    }),
    addSource: vi.fn(),
    getSource: vi.fn(),
    updateSource: vi.fn(),
    removeSource: vi.fn(),
  } as unknown as SourceStore;
}

// Mock the github provider constructors using classes
vi.mock('../providers/github/index.js', () => ({
  GitHubWebhookNormalizer: class {},
  GitHubLockFileFetcher: class {
    constructor(_config: any) {}
  },
  GitHubChangedFilesFetcher: class {
    constructor(_config: any) {}
  },
  GitHubCloneTokenProvider: class {
    constructor(_config: any) {}
  },
  GitHubRepoUrlBuilder: class {},
  GitHubCheckStatusPoster: class {
    constructor(_factory: any) {}
  },
  GitHubContributorResolver: class {
    constructor(_config: any) {}
  },
}));

vi.mock('../providers/github/auth.js', () => ({
  createInstallationOctokit: vi.fn(),
}));

// ── Tests ─────────────────────────────────────────────────────────

describe('SourceManager', () => {
  let mockClient: ReturnType<typeof createMockPoolClient>;
  let mockPool: ReturnType<typeof createMockPool>;
  let onSourcesChanged: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockClient = createMockPoolClient();
    mockPool = createMockPool(mockClient);
    onSourcesChanged = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('start()', () => {
    it('subscribes to LISTEN on sources_change channel', async () => {
      const sourceStore = createMockSourceStore();
      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
      });

      await manager.start();

      expect(mockPool.connect).toHaveBeenCalledOnce();
      expect(mockClient.query).toHaveBeenCalledWith('LISTEN sources_change');
      expect(mockClient.on).toHaveBeenCalledWith('notification', expect.any(Function));
    });

    it('initial reload builds ProviderRegistry from DB sources', async () => {
      const source = makeSource();
      const sourceWithSecrets = makeSourceWithSecrets();
      const secretSources = new Map([['github:42', sourceWithSecrets]]);
      const sourceStore = createMockSourceStore([source], secretSources);

      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
      });

      const registry = await manager.start();

      expect(sourceStore.listSources).toHaveBeenCalled();
      expect(sourceStore.getSourceWithSecrets).toHaveBeenCalledWith('github:42');
      expect(registry.getByRoutingKey('github:42')).toBeDefined();
    });
  });

  describe('NOTIFY triggers reload', () => {
    it('reloads sources on NOTIFY with debounce', async () => {
      const source = makeSource();
      const sourceWithSecrets = makeSourceWithSecrets();
      const secretSources = new Map([['github:42', sourceWithSecrets]]);
      const sourceStore = createMockSourceStore([source], secretSources);

      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
        debounceMs: 100,
      });

      await manager.start();

      // Reset call counts after initial load
      vi.mocked(sourceStore.listSources).mockClear();

      // Simulate NOTIFY
      mockClient._emitNotification('sources_change');

      // Before debounce fires, listSources should NOT be called
      expect(sourceStore.listSources).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(150);

      expect(sourceStore.listSources).toHaveBeenCalledOnce();
    });

    it('multiple rapid NOTIFYs coalesce into single reload', async () => {
      const sourceStore = createMockSourceStore();
      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
        debounceMs: 200,
      });

      await manager.start();
      vi.mocked(sourceStore.listSources).mockClear();

      // Fire 5 rapid notifications
      mockClient._emitNotification('sources_change');
      await vi.advanceTimersByTimeAsync(50);
      mockClient._emitNotification('sources_change');
      await vi.advanceTimersByTimeAsync(50);
      mockClient._emitNotification('sources_change');
      await vi.advanceTimersByTimeAsync(50);
      mockClient._emitNotification('sources_change');
      await vi.advanceTimersByTimeAsync(50);
      mockClient._emitNotification('sources_change');

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(250);

      // Should only reload once
      expect(sourceStore.listSources).toHaveBeenCalledOnce();
    });
  });

  describe('diff callback', () => {
    it('invokes onSourcesChanged with added sources on initial load', async () => {
      const source = makeSource();
      const sourceWithSecrets = makeSourceWithSecrets();
      const secretSources = new Map([['github:42', sourceWithSecrets]]);
      const sourceStore = createMockSourceStore([source], secretSources);

      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
      });

      await manager.start();

      expect(onSourcesChanged).toHaveBeenCalledWith({
        added: [
          { provider: 'github', routingKey: 'github:42', name: 'Test App', subtype: 'github_app' },
        ],
        removed: [],
      });
    });

    it('setOnSourcesChanged rewires the callback used on reload', async () => {
      const source = makeSource();
      const secretSources = new Map([['github:42', makeSourceWithSecrets()]]);
      const sourceStore = createMockSourceStore([source], secretSources);

      const rewired = vi.fn();
      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged, // original (no-op-style) callback
      });
      // Rewire before the initial load: the new callback must receive the diff,
      // and the original must NOT be called.
      manager.setOnSourcesChanged(rewired);

      await manager.start();

      expect(rewired).toHaveBeenCalledWith({
        added: [
          { provider: 'github', routingKey: 'github:42', name: 'Test App', subtype: 'github_app' },
        ],
        removed: [],
      });
      expect(onSourcesChanged).not.toHaveBeenCalled();
    });

    it('invokes onSourcesChanged with removed sources when source disappears', async () => {
      const source = makeSource();
      const sourceWithSecrets = makeSourceWithSecrets();
      const secretSources = new Map([['github:42', sourceWithSecrets]]);
      const sourceStore = createMockSourceStore([source], secretSources);

      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
        debounceMs: 100,
      });

      await manager.start();
      onSourcesChanged.mockClear();

      // Source disappears on next reload
      vi.mocked(sourceStore.listSources).mockResolvedValueOnce([]);

      mockClient._emitNotification('sources_change');
      await vi.advanceTimersByTimeAsync(150);

      expect(onSourcesChanged).toHaveBeenCalledWith({
        added: [],
        removed: [
          { provider: 'github', routingKey: 'github:42', name: 'Test App', subtype: 'github_app' },
        ],
      });
    });

    it('does not invoke onSourcesChanged when no diff', async () => {
      const sourceStore = createMockSourceStore([], new Map());
      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
      });

      await manager.start();

      // No sources => no diff => no callback
      expect(onSourcesChanged).not.toHaveBeenCalled();
    });
  });

  describe('stop()', () => {
    it('releases pg client and unsubscribes', async () => {
      const sourceStore = createMockSourceStore();
      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
      });

      await manager.start();
      await manager.stop();

      expect(mockClient.query).toHaveBeenCalledWith('UNLISTEN sources_change');
      expect(mockClient.release).toHaveBeenCalledOnce();
    });

    it('handles UNLISTEN error gracefully during stop', async () => {
      const sourceStore = createMockSourceStore();
      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
      });

      await manager.start();

      // Simulate connection already closed — UNLISTEN throws
      mockClient.query.mockRejectedValueOnce(new Error('connection terminated'));

      // Should not throw despite UNLISTEN error
      await manager.stop();

      // Client should still be released
      expect(mockClient.release).toHaveBeenCalledOnce();
    });

    it('handles stop when not started', async () => {
      const sourceStore = createMockSourceStore();
      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
      });

      // Should not throw
      await manager.stop();
      expect(mockClient.release).not.toHaveBeenCalled();
    });
  });

  describe('reload() resilience', () => {
    it('skips bad sources and loads remaining sources', async () => {
      const goodSource = makeSource({ id: 's1', routing_key: 'github:42' });
      const badSource = makeSource({
        id: 's2',
        provider: 'unsupported' as any,
        routing_key: 'unsupported:99',
        config: JSON.stringify({ appId: '99' }),
      });
      const goodSourceWithSecrets = makeSourceWithSecrets({
        id: 's1',
        routing_key: 'github:42',
      });
      const badSourceWithSecrets: SourceWithSecrets = {
        ...badSource,
        privateKey: 'PEM-KEY-DATA',
        webhookSecret: 'whsec_test',
      };
      const secretSources = new Map([
        ['github:42', goodSourceWithSecrets],
        ['unsupported:99', badSourceWithSecrets],
      ]);
      const sourceStore = createMockSourceStore([goodSource, badSource], secretSources);

      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
      });

      const registry = await manager.start();

      // Good source should be registered, bad source skipped
      expect(registry.getByRoutingKey('github:42')).toBeDefined();
      expect(registry.getByRoutingKey('unsupported:99')).toBeUndefined();
      expect(manager.getSources()).toEqual([
        { provider: 'github', routingKey: 'github:42', name: 'Test App', subtype: 'github_app' },
      ]);
      // onSourcesChanged should still fire for the good source
      expect(onSourcesChanged).toHaveBeenCalledWith({
        added: [
          { provider: 'github', routingKey: 'github:42', name: 'Test App', subtype: 'github_app' },
        ],
        removed: [],
      });
    });

    it('skips source with malformed config JSON', async () => {
      const source = makeSource({
        config: 'not-valid-json{{{',
      });
      const sourceWithSecrets: SourceWithSecrets = {
        ...source,
        privateKey: 'PEM-KEY-DATA',
      };
      const secretSources = new Map([['github:42', sourceWithSecrets]]);
      const sourceStore = createMockSourceStore([source], secretSources);

      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
      });

      // Should not throw — the bad source is skipped
      const registry = await manager.start();
      expect(registry.getRoutingKeys()).toEqual([]);
    });
  });

  describe('getRegistry()', () => {
    it('returns the current ProviderRegistry', async () => {
      const sourceStore = createMockSourceStore();
      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
      });

      const registry = manager.getRegistry();
      expect(registry).toBeDefined();
      expect(registry.getRoutingKeys()).toEqual([]);
    });
  });

  describe('getSources()', () => {
    it('returns current sources as ProviderSource array', async () => {
      const source = makeSource();
      const sourceWithSecrets = makeSourceWithSecrets();
      const secretSources = new Map([['github:42', sourceWithSecrets]]);
      const sourceStore = createMockSourceStore([source], secretSources);

      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
      });

      await manager.start();

      const sources = manager.getSources();
      expect(sources).toEqual([
        { provider: 'github', routingKey: 'github:42', name: 'Test App', subtype: 'github_app' },
      ]);
    });
  });
});
