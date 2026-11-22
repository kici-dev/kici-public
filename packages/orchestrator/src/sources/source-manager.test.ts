import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { SourceManager, type SourceManagerOptions } from './source-manager.js';
import type { SourceStore, SourceWithSecrets } from './source-store.js';
import type { Source } from '../db/types.js';
import type { GitHubCloneTokenProvider } from '../providers/github/auth.js';

// ── Mock helpers ──────────────────────────────────────────────────

function createMockPoolClient() {
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
    // A real pg client is an EventEmitter; the listener strips its handlers
    // before releasing so they do not ride back into the next checkout.
    removeAllListeners: vi.fn(),
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
    github_url: null,
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

// Mock the github provider constructors that fetch from GitHub; the normalizer, the
// clone-token provider and the URL builder are real, so a test reads what the bundle builds.
const { mockInfo } = vi.hoisted(() => ({ mockInfo: vi.fn() }));
vi.mock('@kici-dev/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kici-dev/shared')>()),
  createLogger: () => ({ info: mockInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../providers/github/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/github/index.js')>();
  return {
    GitHubWebhookNormalizer: actual.GitHubWebhookNormalizer,
    GitHubLockFileFetcher: class {
      constructor(_config: any) {}
    },
    GitHubChangedFilesFetcher: class {
      constructor(_config: any) {}
    },
    GitHubCloneTokenProvider: actual.GitHubCloneTokenProvider,
    GitHubRepoUrlBuilder: actual.GitHubRepoUrlBuilder,
    GitHubCheckStatusPoster: class {
      constructor(_factory: any) {}
    },
  };
});

vi.mock('../providers/github/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/github/auth.js')>()),
  createInstallationOctokit: vi.fn(),
}));

// ── Tests ─────────────────────────────────────────────────────────

describe('SourceManager', () => {
  let mockClient: ReturnType<typeof createMockPoolClient>;
  let mockPool: ReturnType<typeof createMockPool>;
  let onSourcesChanged: Mock<SourceManagerOptions['onSourcesChanged']>;

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

    /** The bundle the manager builds for one github:42 source with `config` and `githubUrl`. */
    async function bundleFor(config: Record<string, unknown>, githubUrl: string | null = null) {
      const overrides = { config: JSON.stringify(config), github_url: githubUrl };
      const sourceStore = createMockSourceStore(
        [makeSource(overrides)],
        new Map([['github:42', makeSourceWithSecrets(overrides)]]),
      );
      const manager = new SourceManager({ pool: mockPool as any, sourceStore, onSourcesChanged });
      return (await manager.start()).getByRoutingKey('github:42')!;
    }

    it('a GHES source builds a bundle whose clone URLs and Octokits use its server', async () => {
      const bundle = await bundleFor({ appId: '42' }, 'https://ghe.corp.example');

      // fails-when: the bundle drops the stored server, so clones and API calls go to github.com
      expect(bundle.repoUrlBuilder!.buildCloneUrl('acme/app')).toBe(
        'https://ghe.corp.example/acme/app.git',
      );
      expect((bundle.cloneTokenProvider as GitHubCloneTokenProvider).getAppConfig().githubUrl).toBe(
        'https://ghe.corp.example',
      );
      // fails-when: the bundle does not name its server, so runs and mints fall back to github.com
      expect(bundle.githubUrl).toBe('https://ghe.corp.example');
      // The webhook credentials never carry the server: no reader trusts a run's
      // provider context for it.
      expect(bundle.normalizer.extractCredentials({ installation: { id: 5 } })).toEqual({
        installationId: 5,
      });
    });

    it('a source whose stored server is not a GitHub web URL builds no bundle', async () => {
      // fails-when: the planted value becomes the bundle's server, or the source
      //   falls back to github.com instead of being refused
      expect(await bundleFor({ appId: '42' }, 'http://evil.example/x')).toBeUndefined();
    });

    // An earlier release's generic config update lets a scoped token store
    // config.githubUrl during a rolling upgrade.
    it('a githubUrl an older peer stored in config has no effect', async () => {
      const bundle = await bundleFor({ appId: '42', githubUrl: 'https://evil.example' });
      // fails-when: the config key becomes the bundle's server
      expect(bundle.repoUrlBuilder!.buildCloneUrl('acme/app')).toBe(
        'https://github.com/acme/app.git',
      );
      expect(bundle).not.toHaveProperty('githubUrl');
    });

    it('a github.com source builds a bundle with github.com URLs and no server', async () => {
      const bundle = await bundleFor({ appId: '42' });

      // breaks-if-wrong: github.com sources keep their clone URLs and App config
      expect(bundle.repoUrlBuilder!.buildCloneUrl('acme/app')).toBe(
        'https://github.com/acme/app.git',
      );
      expect((bundle.cloneTokenProvider as GitHubCloneTokenProvider).getAppConfig()).toEqual({
        appId: '42',
        privateKey: 'PEM-KEY-DATA',
      });
      expect(bundle).not.toHaveProperty('githubUrl');
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

      mockClient._emitNotification('sources_change');

      // Before debounce fires, listSources should NOT be called
      expect(sourceStore.listSources).not.toHaveBeenCalled();

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

      mockClient._emitNotification('sources_change');
      await vi.advanceTimersByTimeAsync(50);
      mockClient._emitNotification('sources_change');
      await vi.advanceTimersByTimeAsync(50);
      mockClient._emitNotification('sources_change');
      await vi.advanceTimersByTimeAsync(50);
      mockClient._emitNotification('sources_change');
      await vi.advanceTimersByTimeAsync(50);
      mockClient._emitNotification('sources_change');

      await vi.advanceTimersByTimeAsync(250);

      expect(sourceStore.listSources).toHaveBeenCalledOnce();
    });
  });

  describe('a reload updates the registry start returned', () => {
    it('serves a source added after start, keeps foreign bundles, and drops a removed one', async () => {
      const sources: Source[] = [];
      const secrets = new Map<string, SourceWithSecrets>();
      const sourceStore = createMockSourceStore(sources, secrets);
      const manager = new SourceManager({ pool: mockPool as any, sourceStore, onSourcesChanged });
      // The registry the webhook pipeline, the dispatcher and the reporter hold from boot.
      const registry = await manager.start();
      const foreign = { normalizer: {} as never };
      registry.register('generic', foreign);
      expect(registry.hasExact('github:42')).toBe(false);

      sources.push(makeSource());
      secrets.set('github:42', makeSourceWithSecrets());
      await manager.reload();

      // fails-when: the reload builds a new registry, so the boot instance never learns
      //   a source added while the orchestrator runs ("Unknown provider, skipping")
      expect(registry.hasExact('github:42')).toBe(true);
      expect(manager.getRegistry()).toBe(registry);
      // breaks-if-wrong: bundles other components registered survive a reload
      expect(registry.getByRoutingKey('generic:org:src')).toBe(foreign);

      sources.length = 0;
      await manager.reload();
      expect(registry.hasExact('github:42')).toBe(false);
      expect(registry.getByRoutingKey('generic:org:src')).toBe(foreign);
    });

    /** A started manager whose store lists no source yet but holds github:42's secrets. */
    async function startWithEmptySources() {
      const sourceStore = createMockSourceStore(
        [],
        new Map([['github:42', makeSourceWithSecrets()]]),
      );
      const manager = new SourceManager({ pool: mockPool as any, sourceStore, onSourcesChanged });
      return { sourceStore, manager, registry: await manager.start() };
    }

    it('overlapping reloads apply in the order they were requested', async () => {
      const { sourceStore, manager, registry } = await startWithEmptySources();

      // The first reload reads a DB view that still has the source, and its read is slow.
      let finishStaleRead!: (rows: Source[]) => void;
      vi.mocked(sourceStore.listSources)
        .mockImplementationOnce(() => new Promise((resolve) => (finishStaleRead = resolve)))
        .mockResolvedValueOnce([]);

      const stale = manager.reload();
      const fresh = manager.reload();
      await vi.advanceTimersByTimeAsync(0);
      finishStaleRead([makeSource()]);
      await Promise.all([stale, fresh]);

      // fails-when: the second reload applies first and the stale one then re-registers
      //   the source it removed
      expect(registry.hasExact('github:42')).toBe(false);
      expect(sourceStore.listSources).toHaveBeenCalledTimes(3);
    });

    it('a failed reload does not block the next one', async () => {
      const { sourceStore, manager, registry } = await startWithEmptySources();

      vi.mocked(sourceStore.listSources)
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce([makeSource()]);

      await expect(manager.reload()).rejects.toThrow('db down');
      // breaks-if-wrong: the queue keeps serving reloads after one fails
      await manager.reload();
      expect(registry.hasExact('github:42')).toBe(true);
    });

    it('a burst of reloads during a running one costs one more DB read, and the last view stays', async () => {
      const { sourceStore, manager, registry } = await startWithEmptySources();

      let finishRunningRead!: (rows: Source[]) => void;
      vi.mocked(sourceStore.listSources)
        .mockImplementationOnce(() => new Promise((resolve) => (finishRunningRead = resolve)))
        .mockResolvedValueOnce([makeSource()]);

      const running = manager.reload();
      await vi.advanceTimersByTimeAsync(0);
      const burst = [manager.reload(), manager.reload(), manager.reload(), manager.reload()];
      finishRunningRead([]);
      await Promise.all([running, ...burst]);

      // fails-when: every queued request reads the DB again (N requests -> N reads)
      expect(sourceStore.listSources).toHaveBeenCalledTimes(3);
      // breaks-if-wrong: the coalesced reload still reads after the last request and applies
      expect(registry.hasExact('github:42')).toBe(true);
    });

    it('the boot load waits for a slow DB read; a later reload is bounded', async () => {
      const sourceStore = createMockSourceStore(
        [],
        new Map([['github:42', makeSourceWithSecrets()]]),
      );
      let finishBootRead!: (rows: Source[]) => void;
      vi.mocked(sourceStore.listSources).mockImplementationOnce(
        () => new Promise((resolve) => (finishBootRead = resolve)),
      );
      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
        reloadTimeoutMs: 1_000,
      });

      mockInfo.mockClear();
      const started = manager.start();
      await vi.advanceTimersByTimeAsync(5_000);
      // fails-when: a boot read that hangs leaves no log line
      expect(mockInfo).toHaveBeenCalledWith('Loading sources from the database');
      expect(mockInfo).not.toHaveBeenCalledWith('Loaded sources', expect.anything());
      finishBootRead([makeSource()]);
      // fails-when: a boot read slower than the reload bound fails startup
      const registry = await started;
      expect(registry.hasExact('github:42')).toBe(true);
      expect(mockInfo).toHaveBeenCalledWith('Loaded sources', {
        count: 1,
        elapsedMs: expect.any(Number),
      });
      const loaded = mockInfo.mock.calls.find(([message]) => message === 'Loaded sources')!;
      expect((loaded[1] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(5_000);

      // breaks-if-wrong: a later reload keeps its bound
      vi.mocked(sourceStore.listSources).mockImplementationOnce(() => new Promise(() => undefined));
      const later = manager.reload();
      const laterResult = expect(later).rejects.toThrow('Source reload timed out after 1000ms');
      await vi.advanceTimersByTimeAsync(1_000);
      await laterResult;
    });

    it('a DB read that never answers fails its reload and lets the next one run', async () => {
      const sourceStore = createMockSourceStore(
        [],
        new Map([['github:42', makeSourceWithSecrets()]]),
      );
      const manager = new SourceManager({
        pool: mockPool as any,
        sourceStore,
        onSourcesChanged,
        reloadTimeoutMs: 1_000,
      });
      const registry = await manager.start();

      let finishHungRead!: (rows: Source[]) => void;
      vi.mocked(sourceStore.listSources)
        .mockImplementationOnce(() => new Promise((resolve) => (finishHungRead = resolve)))
        .mockResolvedValueOnce([makeSource()]);

      const hung = manager.reload();
      const hungResult = expect(hung).rejects.toThrow('Source reload timed out after 1000ms');
      const next = manager.reload();
      await vi.advanceTimersByTimeAsync(1_000);
      // fails-when: the queue waits on the hung read forever and the next reload never runs
      await hungResult;
      await next;
      expect(registry.hasExact('github:42')).toBe(true);

      // A late answer from the timed-out read is discarded, not applied over the newer view.
      finishHungRead([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(registry.hasExact('github:42')).toBe(true);
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

describe('GitHub-App sources in observed mode', () => {
  // fails-when: the observed startup assertion exists — start() rejects.
  // breaks-if-wrong: the hybrid / no-mode starts elsewhere in this file still pass.
  it('starts over a GitHub-App row and registers it as github_app', async () => {
    const client = createMockPoolClient();
    const mgr = new SourceManager({
      pool: createMockPool(client) as never,
      sourceStore: createMockSourceStore(
        [makeSource()],
        new Map([['github:42', makeSourceWithSecrets()]]),
      ),
      onSourcesChanged: () => {},
    });
    await expect(mgr.start()).resolves.toBeDefined();
    expect(mgr.getSources()).toEqual([
      { provider: 'github', routingKey: 'github:42', name: 'Test App', subtype: 'github_app' },
    ]);
    await mgr.stop();
  });
});
