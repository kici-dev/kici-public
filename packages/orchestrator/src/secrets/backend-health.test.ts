/**
 * Tests for BackendHealthChecker.
 *
 * Mocks BackendRegistry and network calls to verify:
 * - PG health check returns healthy/unreachable based on query result
 * - Vault health check returns healthy/degraded/unreachable based on /sys/health
 * - checkAllBackends aggregates results from all enabled backends
 * - Periodic health checks call checkHealth at configured interval
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackendHealthChecker } from './backend-health.js';
import type { BackendDescriptor, BackendHealthStatus } from '@kici-dev/engine';

// ── Mock setup ─────────────────────────────────────────────────

// Injectable PG probe for tests
const mockPgProbe = vi.fn().mockResolvedValue(undefined);

// Mock global fetch for Vault health checks
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeDescriptor(overrides: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    id: 'uuid-1',
    name: 'test-backend',
    backendType: 'vault',
    scopeFilter: '**',
    syncIntervalMs: 300000,
    enabled: true,
    healthStatus: 'unknown',
    scopeCount: 0,
    lastSyncAt: null,
    lastSyncError: null,
    lastHealthCheckAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRegistry(
  overrides: {
    backends?: BackendDescriptor[];
    config?: Record<string, unknown> | null;
  } = {},
) {
  return {
    getBackend: vi.fn().mockResolvedValue(overrides.backends?.[0] ?? makeDescriptor()),
    getBackendConfig: vi
      .fn()
      .mockResolvedValue(
        overrides.config !== undefined ? overrides.config : { vaultUrl: 'http://vault:8200' },
      ),
    listBackends: vi.fn().mockResolvedValue(overrides.backends ?? [makeDescriptor()]),
    updateHealthStatus: vi.fn().mockResolvedValue(undefined),
  } as any;
}

// ── Tests ──────────────────────────────────────────────────────

describe('BackendHealthChecker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockPgProbe.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkHealth - PG backend', () => {
    it('returns healthy when DB query succeeds', async () => {
      const registry = makeRegistry({
        backends: [makeDescriptor({ backendType: 'pg', name: 'pg-backend' })],
        config: { connectionString: 'postgresql://localhost/test' },
      });
      const logger = makeLogger();
      const checker = new BackendHealthChecker(registry, logger, mockPgProbe);

      const status = await checker.checkHealth('pg-backend');
      expect(status).toBe('healthy');
      expect(registry.updateHealthStatus).toHaveBeenCalledWith('pg-backend', 'healthy', undefined);
    });

    it('returns unreachable when DB query throws', async () => {
      mockPgProbe.mockRejectedValueOnce(new Error('Connection refused'));

      const registry = makeRegistry({
        backends: [makeDescriptor({ backendType: 'pg', name: 'pg-backend' })],
        config: { connectionString: 'postgresql://localhost/test' },
      });
      const logger = makeLogger();
      const checker = new BackendHealthChecker(registry, logger, mockPgProbe);

      const status = await checker.checkHealth('pg-backend');
      expect(status).toBe('unreachable');
      expect(registry.updateHealthStatus).toHaveBeenCalledWith(
        'pg-backend',
        'unreachable',
        'Health check failed',
      );
    });
  });

  describe('checkHealth - Vault backend', () => {
    it('returns healthy when /sys/health returns sealed=false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ sealed: false, initialized: true }),
      });

      const registry = makeRegistry({
        backends: [makeDescriptor({ backendType: 'vault', name: 'vault-backend' })],
        config: { vaultUrl: 'http://vault:8200' },
      });
      const logger = makeLogger();
      const checker = new BackendHealthChecker(registry, logger, mockPgProbe);

      const status = await checker.checkHealth('vault-backend');
      expect(status).toBe('healthy');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://vault:8200/v1/sys/health',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it('returns unreachable on connection timeout', async () => {
      mockFetch.mockRejectedValueOnce(new Error('fetch failed'));

      const registry = makeRegistry({
        backends: [makeDescriptor({ backendType: 'vault', name: 'vault-backend' })],
        config: { vaultUrl: 'http://vault:8200' },
      });
      const logger = makeLogger();
      const checker = new BackendHealthChecker(registry, logger, mockPgProbe);

      const status = await checker.checkHealth('vault-backend');
      expect(status).toBe('unreachable');
    });

    it('returns degraded when sealed=true', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ sealed: true, initialized: true }),
      });

      const registry = makeRegistry({
        backends: [makeDescriptor({ backendType: 'vault', name: 'vault-backend' })],
        config: { vaultUrl: 'http://vault:8200' },
      });
      const logger = makeLogger();
      const checker = new BackendHealthChecker(registry, logger, mockPgProbe);

      const status = await checker.checkHealth('vault-backend');
      expect(status).toBe('degraded');
    });
  });

  describe('checkAllBackends', () => {
    it('returns map of name -> health status', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ sealed: false }),
      });

      const backends = [
        makeDescriptor({ name: 'vault-1', backendType: 'vault' }),
        makeDescriptor({ name: 'vault-2', backendType: 'vault' }),
      ];

      const registry = makeRegistry({ backends });
      // getBackend and getBackendConfig must work for each name
      registry.getBackend.mockImplementation(
        async (name: string) => backends.find((b) => b.name === name) ?? null,
      );
      registry.getBackendConfig.mockResolvedValue({ vaultUrl: 'http://vault:8200' });

      const logger = makeLogger();
      const checker = new BackendHealthChecker(registry, logger, mockPgProbe);

      const results = await checker.checkAllBackends();
      expect(results.size).toBe(2);
      expect(results.get('vault-1')).toBe('healthy');
      expect(results.get('vault-2')).toBe('healthy');
    });
  });

  describe('startPeriodicCheck', () => {
    it('calls checkHealth at configured interval', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ sealed: false }),
      });

      const registry = makeRegistry();
      const logger = makeLogger();
      const checker = new BackendHealthChecker(registry, logger, mockPgProbe);

      checker.startPeriodicCheck(1000);

      // Advance 1 interval
      await vi.advanceTimersByTimeAsync(1000);

      expect(registry.listBackends).toHaveBeenCalled();

      checker.stopPeriodicCheck();
    });
  });

  describe('testConnection', () => {
    it('returns ok=true for healthy vault', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ sealed: false }),
      });

      const registry = makeRegistry();
      const logger = makeLogger();
      const checker = new BackendHealthChecker(registry, logger, mockPgProbe);

      const result = await checker.testConnection({
        name: 'test-vault',
        backendType: 'vault',
        config: { vaultUrl: 'http://vault:8200' },
      });

      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns ok=false for unreachable vault', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const registry = makeRegistry();
      const logger = makeLogger();
      const checker = new BackendHealthChecker(registry, logger, mockPgProbe);

      const result = await checker.testConnection({
        name: 'test-vault',
        backendType: 'vault',
        config: { vaultUrl: 'http://vault:8200' },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
