import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigReloader } from './reload.js';
import type { ConfigReloaderDeps, ReloadResult } from './reload.js';
import type { AppConfig, SharedConfig } from './types.js';

/**
 * Create a minimal AppConfig for testing purposes.
 * Provides all required fields with sensible defaults.
 */
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    instanceId: 'test-orch-1',
    mode: 'independent',
    databaseUrl: 'postgres://localhost/kici',
    port: 4000,
    basePath: '/',
    agentAuth: 'token',
    agentTokenTtlMs: 3_600_000,
    queueMaxDepth: 1000,
    queueTimeoutMs: 3_600_000,
    lockfileCacheMax: 500,
    lockfileCacheTtlMs: 3_600_000,
    staleDetectorScanIntervalMs: 60_000,
    staleDetectorThresholdMultiplier: 2,
    jobHeartbeatIntervalMs: 60_000,
    cluster: {
      instanceId: 'cluster-1',
      credentialFile: '~/.kici/peer-credential',
      autoRotateCredentials: false,
      peers: [],
      raftElectionTimeoutMinMs: 5000,
      raftElectionTimeoutMaxMs: 10000,
      raftHeartbeatMs: 2000,
      peerHeartbeatIntervalMs: 30000,
      peerMaxReconnectDelayMs: 60000,
    },
    cacheTtlDays: 30,
    cacheBuildTimeoutMs: 600_000,
    cacheMaxTarballBytes: 524_288_000,
    logLevel: 'info',
    nodeEnv: 'test',
    ...overrides,
  };
}

/**
 * Create mock deps with sensible defaults.
 */
function makeDeps(overrides: Partial<ConfigReloaderDeps> = {}): ConfigReloaderDeps {
  const newConfig = makeConfig({ logLevel: 'debug' }); // slightly different config
  return {
    resolveLocalConfig: vi.fn().mockResolvedValue({ local: { server: { logLevel: 'debug' } } }),
    resolveFullConfig: vi.fn().mockReturnValue(newConfig),
    sharedStore: null,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

describe('ConfigReloader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('successful reload', () => {
    it('resolves new config and calls onConfigApplied', async () => {
      const initialConfig = makeConfig();
      const newConfig = makeConfig({ logLevel: 'debug' });
      const onConfigApplied = vi.fn();

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
        onConfigApplied,
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'http' });

      expect(result.success).toBe(true);
      expect(onConfigApplied).toHaveBeenCalledWith(newConfig);
      expect(reloader.getCurrentConfig()).toBe(newConfig);
    });

    it('returns fieldsChanged list', async () => {
      const initialConfig = makeConfig({ logLevel: 'info' });
      const newConfig = makeConfig({ logLevel: 'debug' });

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'http' });

      expect(result.success).toBe(true);
      expect(result.fieldsChanged).toContain('logLevel');
    });

    it('reads version from shared store', async () => {
      const initialConfig = makeConfig();
      const newConfig = makeConfig({ logLevel: 'debug' });
      const mockStore = {
        getLatest: vi.fn().mockResolvedValue({
          config: { logLevel: 'debug' } satisfies Partial<SharedConfig>,
          version: 42,
        }),
      };

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
        sharedStore: mockStore as unknown as ConfigReloaderDeps['sharedStore'],
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'cli' });

      expect(result.success).toBe(true);
      expect(result.version).toBe(42);
      expect(reloader.getCurrentVersion()).toBe(42);
    });
  });

  describe('validation failure', () => {
    it('preserves old config when resolveFullConfig throws', async () => {
      const initialConfig = makeConfig();

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockImplementation(() => {
          throw new Error('Validation failed: databaseUrl is required');
        }),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'sighup' });

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Validation failed: databaseUrl is required');
      expect(reloader.getCurrentConfig()).toBe(initialConfig);
    });

    it('logs error on validation failure', async () => {
      const initialConfig = makeConfig();
      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockImplementation(() => {
          throw new Error('invalid config');
        }),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      await reloader.executeReload({ source: 'http' });

      expect(deps.logger.error).toHaveBeenCalledWith(
        'Config reload validation failed, keeping old config',
        expect.objectContaining({ error: 'invalid config' }),
      );
    });
  });

  describe('concurrent reload mutex', () => {
    it('rejects second reload while first is in progress', async () => {
      const initialConfig = makeConfig();

      // Make resolveLocalConfig take time to resolve
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((r) => {
        resolveFirst = r;
      });

      const newConfig = makeConfig({ logLevel: 'debug' });
      const deps = makeDeps({
        resolveLocalConfig: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              firstPromise.then(() => resolve({ local: {} }));
            }),
        ),
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
      });

      const reloader = new ConfigReloader(initialConfig, deps);

      // Start first reload (will block on resolveLocalConfig)
      const reload1Promise = reloader.executeReload({ source: 'http' });

      // Start second reload (should fail with mutex error)
      const result2 = await reloader.executeReload({ source: 'cli' });

      expect(result2.success).toBe(false);
      expect(result2.errors).toContain('Reload already in progress');

      // Complete first reload
      resolveFirst!();
      const result1 = await reload1Promise;
      expect(result1.success).toBe(true);
    });
  });

  describe('debounce', () => {
    it('triggers executeReload only once after debounce period for rapid triggers', async () => {
      const initialConfig = makeConfig();
      const newConfig = makeConfig({ logLevel: 'debug' });

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const executeSpy = vi.spyOn(reloader, 'executeReload');

      // Trigger 3 rapid reloads
      reloader.triggerReload('sighup');
      reloader.triggerReload('sighup');
      reloader.triggerReload('sighup');

      // Before debounce period, no reload should have executed
      expect(executeSpy).not.toHaveBeenCalled();

      // Advance past debounce period
      await vi.advanceTimersByTimeAsync(ConfigReloader.DEBOUNCE_MS + 10);

      // Only one reload should have executed
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it('resets debounce timer on each trigger', async () => {
      const initialConfig = makeConfig();
      const newConfig = makeConfig({ logLevel: 'debug' });

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const executeSpy = vi.spyOn(reloader, 'executeReload');

      // Trigger at t=0
      reloader.triggerReload('sighup');

      // Advance to t=400 (within debounce window of 500ms)
      await vi.advanceTimersByTimeAsync(400);
      expect(executeSpy).not.toHaveBeenCalled();

      // Trigger again at t=400 (resets debounce)
      reloader.triggerReload('sighup');

      // Advance to t=800 (within new debounce window from t=400)
      await vi.advanceTimersByTimeAsync(400);
      expect(executeSpy).not.toHaveBeenCalled();

      // Advance past debounce from last trigger
      await vi.advanceTimersByTimeAsync(200);
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('restart-required detection', () => {
    it('detects databaseUrl change and preserves old value', async () => {
      const initialConfig = makeConfig({ databaseUrl: 'postgres://old/db' });
      const newConfig = makeConfig({ databaseUrl: 'postgres://new/db' });

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'http' });

      expect(result.success).toBe(true);
      expect(result.restartRequired).toContain('databaseUrl');
      // Old database URL should be preserved
      expect(reloader.getCurrentConfig().databaseUrl).toBe('postgres://old/db');
    });

    it('detects port change and preserves old value', async () => {
      const initialConfig = makeConfig({ port: 4000 });
      const newConfig = makeConfig({ port: 5000 });

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'http' });

      expect(result.success).toBe(true);
      expect(result.restartRequired).toContain('port');
      expect(reloader.getCurrentConfig().port).toBe(4000);
    });

    it('detects instanceId change and preserves old value', async () => {
      const initialConfig = makeConfig({ instanceId: 'old-id' });
      const newConfig = makeConfig({ instanceId: 'new-id' });

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'http' });

      expect(result.success).toBe(true);
      expect(result.restartRequired).toContain('instanceId');
      expect(reloader.getCurrentConfig().instanceId).toBe('old-id');
    });

    it('does not include restartRequired when no restart-fields changed', async () => {
      const initialConfig = makeConfig();
      const newConfig = makeConfig({ logLevel: 'debug' });

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'http' });

      expect(result.success).toBe(true);
      expect(result.restartRequired).toBeUndefined();
    });
  });

  describe('drain mode', () => {
    it('calls startDrain before config swap and stopDrain after', async () => {
      const callOrder: string[] = [];
      const initialConfig = makeConfig();
      const newConfig = makeConfig({ logLevel: 'debug' });

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
        startDrain: vi.fn().mockImplementation(async () => {
          callOrder.push('startDrain');
        }),
        stopDrain: vi.fn().mockImplementation(() => {
          callOrder.push('stopDrain');
        }),
        onConfigApplied: vi.fn().mockImplementation(() => {
          callOrder.push('configApplied');
        }),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'http', drain: true });

      expect(result.success).toBe(true);
      expect(deps.startDrain).toHaveBeenCalled();
      expect(deps.stopDrain).toHaveBeenCalled();

      // Verify order: drain -> swap -> resume
      expect(callOrder).toEqual(['startDrain', 'configApplied', 'stopDrain']);
    });

    it('does not call drain callbacks when drain=false', async () => {
      const initialConfig = makeConfig();
      const newConfig = makeConfig({ logLevel: 'debug' });

      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
        startDrain: vi.fn(),
        stopDrain: vi.fn(),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      await reloader.executeReload({ source: 'http', drain: false });

      expect(deps.startDrain).not.toHaveBeenCalled();
      expect(deps.stopDrain).not.toHaveBeenCalled();
    });
  });

  describe('provider change callback', () => {
    it('never calls onProviderChange (providers managed via sources table)', async () => {
      const initialConfig = makeConfig({ logLevel: 'info' });
      const newConfig = makeConfig({ logLevel: 'debug' });

      const onProviderChange = vi.fn();
      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
        onProviderChange,
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      await reloader.executeReload({ source: 'http' });

      // Provider config is now managed via the sources table, not AppConfig
      expect(onProviderChange).not.toHaveBeenCalled();
    });
  });

  describe('Platform reconnect callback', () => {
    it('calls onPlatformReconnect when Platform URL changes', async () => {
      const initialConfig = makeConfig({ platformUrl: 'ws://old-platform' });
      const newConfig = makeConfig({ platformUrl: 'ws://new-platform' });

      const onPlatformReconnect = vi.fn();
      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
        onPlatformReconnect,
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      await reloader.executeReload({ source: 'http' });

      expect(onPlatformReconnect).toHaveBeenCalledWith(newConfig);
    });
  });

  describe('scaler reload callback', () => {
    it('always calls onScalerReload on successful reload', async () => {
      const initialConfig = makeConfig();
      const newConfig = makeConfig({ logLevel: 'debug' });

      const onScalerReload = vi.fn();
      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
        onScalerReload,
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      await reloader.executeReload({ source: 'sighup' });

      expect(onScalerReload).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('preserves old config when resolveLocalConfig throws', async () => {
      const initialConfig = makeConfig();

      const deps = makeDeps({
        resolveLocalConfig: vi.fn().mockRejectedValue(new Error('YAML parse error')),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'http' });

      expect(result.success).toBe(false);
      expect(result.errors).toContain('YAML parse error');
      expect(reloader.getCurrentConfig()).toBe(initialConfig);
    });

    it('logs error when reload fails', async () => {
      const initialConfig = makeConfig();
      const deps = makeDeps({
        resolveLocalConfig: vi.fn().mockRejectedValue(new Error('file not found')),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      await reloader.executeReload({ source: 'cli' });

      expect(deps.logger.error).toHaveBeenCalledWith(
        'Config reload failed',
        expect.objectContaining({ error: 'file not found' }),
      );
    });

    it('releases mutex after error', async () => {
      const initialConfig = makeConfig();
      const newConfig = makeConfig({ logLevel: 'debug' });

      const deps = makeDeps({
        resolveLocalConfig: vi
          .fn()
          .mockRejectedValueOnce(new Error('first fail'))
          .mockResolvedValueOnce({ local: {} }),
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
      });

      const reloader = new ConfigReloader(initialConfig, deps);

      // First reload fails
      const result1 = await reloader.executeReload({ source: 'http' });
      expect(result1.success).toBe(false);

      // Second reload should NOT be rejected by mutex
      const result2 = await reloader.executeReload({ source: 'http' });
      expect(result2.success).toBe(true);
    });
  });

  describe('dispose', () => {
    it('clears pending debounce timer', async () => {
      const initialConfig = makeConfig();
      const deps = makeDeps();
      const reloader = new ConfigReloader(initialConfig, deps);
      const executeSpy = vi.spyOn(reloader, 'executeReload');

      // Trigger a reload (sets debounce timer)
      reloader.triggerReload('sighup');

      // Dispose before debounce fires
      reloader.dispose();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(ConfigReloader.DEBOUNCE_MS + 100);

      // Reload should NOT have been called
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  describe('getCurrentConfig / getCurrentVersion', () => {
    it('returns initial config before any reload', () => {
      const initialConfig = makeConfig();
      const deps = makeDeps();
      const reloader = new ConfigReloader(initialConfig, deps);

      expect(reloader.getCurrentConfig()).toBe(initialConfig);
      expect(reloader.getCurrentVersion()).toBe(0);
    });

    it('returns updated config after reload', async () => {
      const initialConfig = makeConfig();
      const newConfig = makeConfig({ logLevel: 'debug' });
      const deps = makeDeps({
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
      });

      const reloader = new ConfigReloader(initialConfig, deps);
      await reloader.executeReload({ source: 'http' });

      expect(reloader.getCurrentConfig()).toBe(newConfig);
    });
  });
});
