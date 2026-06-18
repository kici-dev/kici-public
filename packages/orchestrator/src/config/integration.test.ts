/**
 * Integration tests for the config system.
 *
 * Tests the full config lifecycle without external dependencies:
 * - Resolution chain precedence (env > YAML > DB > defaults)
 * - Config seed + get round-trip with encryption
 * - Config reload simulation
 * - Multi-app provider registry
 * - Config rollback
 * - Env var mapping
 * - Restart-required field detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolveFullConfig, resolveLocalConfig, getDefaults } from './resolver.js';
import { SharedConfigStore } from './shared-store.js';
import { ConfigReloader } from './reload.js';
import type { ConfigReloaderDeps } from './reload.js';
import type { AppConfig, SharedConfig } from './types.js';
import { REDACTED_VALUE } from './encryption.js';

// ── Helpers ────────────────────────────────────────────────────

const TEST_MASTER_KEY = randomBytes(32);

async function createTmpDir(): Promise<string> {
  const dir = join(tmpdir(), `kici-integration-test-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeMinimalLocal(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    database: { url: 'pg://integration-test' },
    instance: { mode: 'independent' },
    ...overrides,
  };
}

function makeShared(overrides?: Partial<SharedConfig>): SharedConfig {
  return {
    agentAuth: 'token',
    ...overrides,
  };
}

function makeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    instanceId: 'test-orch-1',
    mode: 'independent',
    databaseUrl: 'postgres://localhost/kici',
    port: 4000,
    basePath: '/',
    agentAuth: 'token',
    agentTokenTtlMs: 3_600_000,
    rosterGraceMs: 300_000,
    rosterTtlMs: 1_800_000,
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

// ── Mock DB builder for SharedConfigStore ────────────────────
//
// NOTE: This test uses a specialized stateful mock (in-memory rows array with
// version tracking) instead of the shared createMockDb() from
// '../__test-helpers__/mock-db.js' because integration tests need actual
// data persistence across multiple save/getLatest/rollback operations.

interface MockDbState {
  rows: Array<Record<string, unknown>>;
  nextVersion: number;
}

function createMockDbForStore(): {
  db: any;
  state: MockDbState;
} {
  const state: MockDbState = {
    rows: [],
    nextVersion: 1,
  };

  const db = {
    selectFrom: vi.fn().mockImplementation(() => {
      return {
        selectAll: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation((_col: string, _op: string, version: number) => {
            return {
              executeTakeFirst: vi.fn().mockImplementation(async () => {
                return state.rows.find((r) => r.version === version) ?? undefined;
              }),
            };
          }),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              execute: vi.fn().mockImplementation(async () => {
                return [...state.rows].sort(
                  (a, b) => (b.version as number) - (a.version as number),
                );
              }),
              executeTakeFirst: vi.fn().mockImplementation(async () => {
                const sorted = [...state.rows].sort(
                  (a, b) => (b.version as number) - (a.version as number),
                );
                return sorted[0] ?? undefined;
              }),
            }),
          }),
        }),
        select: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              execute: vi.fn().mockImplementation(async () => {
                return [...state.rows].sort(
                  (a, b) => (b.version as number) - (a.version as number),
                );
              }),
              executeTakeFirst: vi.fn().mockImplementation(async () => {
                const sorted = [...state.rows].sort(
                  (a, b) => (b.version as number) - (a.version as number),
                );
                return sorted[0] ?? undefined;
              }),
            }),
          }),
        }),
      };
    }),
    insertInto: vi.fn().mockImplementation(() => {
      return {
        values: vi.fn().mockImplementation((row: Record<string, unknown>) => {
          return {
            returning: vi.fn().mockReturnValue({
              executeTakeFirstOrThrow: vi.fn().mockImplementation(async () => {
                const version = state.nextVersion++;
                const newRow = {
                  id: randomUUID(),
                  version,
                  config: row.config,
                  created_at: new Date(),
                  created_by: row.created_by,
                  description: row.description,
                  encrypted_paths: row.encrypted_paths ?? [],
                  key_version: (row.key_version as number | undefined) ?? 1,
                };
                state.rows.push(newRow);
                return { version };
              }),
            }),
          };
        }),
      };
    }),
  };

  return { db, state };
}

// ── Test Suites ─────────────────────────────────────────────

describe('Config Integration Tests', () => {
  describe('1. Full resolution chain test', () => {
    it('verifies env > YAML > DB > defaults precedence', () => {
      // YAML has partial config
      const yamlConfig = makeMinimalLocal({
        server: { port: 4000 },
      });

      // DB has partial shared config
      const dbConfig: SharedConfig = {
        queue: { maxDepth: 500 },
        lockfileCache: { max: 200 },
      };

      // Env vars override specific fields
      const env = {
        KICI_SERVER_PORT: '5000',
        KICI_QUEUE_MAX_DEPTH: '2000',
      };

      const result = resolveFullConfig(yamlConfig, dbConfig, env);

      // env > YAML: port should be 5000 (env wins over YAML's 4000)
      expect(result.port).toBe(5000);

      // env > DB: queueMaxDepth should be 2000 (env wins over DB's 500)
      expect(result.queueMaxDepth).toBe(2000);

      // DB value used: lockfileCacheMax should be 200 (from DB, not default 500)
      expect(result.lockfileCacheMax).toBe(200);

      // Default value: staleDetectorScanIntervalMs should be 60000 (default, not in DB or YAML)
      expect(result.staleDetectorScanIntervalMs).toBe(60_000);

      // YAML value: databaseUrl should come from YAML
      expect(result.databaseUrl).toBe('pg://integration-test');
    });

    it('works with no DB config (null)', () => {
      const yamlConfig = makeMinimalLocal();

      const result = resolveFullConfig(yamlConfig, null, {});

      expect(result.databaseUrl).toBe('pg://integration-test');
      // Defaults applied when no DB config
      expect(result.queueMaxDepth).toBe(1000);
      expect(result.agentAuth).toBe('token');
    });
  });

  describe('2. Config seed + get round-trip', () => {
    it('seeds config with encryption and retrieves it decrypted', async () => {
      const { db, state } = createMockDbForStore();
      const store = new SharedConfigStore(db, TEST_MASTER_KEY);

      // Seed a config with sensitive fields
      const config = {
        platform: {
          url: 'wss://relay.kici.dev',
          token: 'platform-token-value',
        },
        secrets: {
          key: 'master-key-value',
        },
        agentAuth: 'token',
      };

      const version = await store.save(config, 'cli:seed', 'Integration test seed');
      expect(version).toBe(1);

      // Verify sensitive fields were encrypted in storage
      const storedRow = state.rows[0];
      const storedConfig = JSON.parse(storedRow.config as string);
      expect(storedConfig.platform.token).not.toBe('platform-token-value');
      expect(storedConfig.secrets.key).not.toBe('master-key-value');

      // Verify encrypted_paths are tracked
      const encryptedPaths = storedRow.encrypted_paths as string[];
      expect(encryptedPaths).toContain('platform.token');
      expect(encryptedPaths).toContain('secrets.key');

      // Get latest should return decrypted values
      const latest = await store.getLatest();
      expect(latest).not.toBeNull();
      expect(latest!.version).toBe(1);
      expect(latest!.config.platform?.token).toBe('platform-token-value');
      expect(latest!.config.secrets?.key).toBe('master-key-value');
    });

    it('exports config with redacted sensitive fields', async () => {
      const { db, state } = createMockDbForStore();
      const store = new SharedConfigStore(db, TEST_MASTER_KEY);

      const config = {
        platform: {
          url: 'wss://relay.kici.dev',
          token: 'platform-token-value',
        },
        secrets: {
          key: 'master-key-value',
        },
      };

      await store.save(config, 'cli:seed');

      const redacted = await store.exportRedacted();
      expect(redacted).not.toBeNull();

      // Sensitive fields should be redacted
      expect((redacted as any).platform.token).toBe(REDACTED_VALUE);
      expect((redacted as any).secrets.key).toBe(REDACTED_VALUE);

      // Non-sensitive fields should be visible
      expect((redacted as any).platform.url).toBe('wss://relay.kici.dev');
    });
  });

  describe('3. Config reload simulation', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await createTmpDir();
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('reloads config when YAML file changes', async () => {
      const initialConfig = makeAppConfig({ logLevel: 'info' });
      const updatedConfig = makeAppConfig({ logLevel: 'debug' });
      const configApplied: AppConfig[] = [];

      let resolveCallCount = 0;
      const deps: ConfigReloaderDeps = {
        resolveLocalConfig: vi.fn().mockResolvedValue({ local: makeMinimalLocal() }),
        resolveFullConfig: vi.fn().mockImplementation(() => {
          resolveCallCount++;
          // Second call returns updated config
          return resolveCallCount === 1 ? updatedConfig : updatedConfig;
        }),
        sharedStore: null,
        onConfigApplied: vi.fn().mockImplementation((config: AppConfig) => {
          configApplied.push(config);
        }),
        onScalerReload: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };

      const reloader = new ConfigReloader(initialConfig, deps);

      // Verify initial state
      expect(reloader.getCurrentConfig().logLevel).toBe('info');

      // Trigger reload
      const result = await reloader.executeReload({ source: 'sighup' });

      // Verify reload succeeded
      expect(result.success).toBe(true);
      expect(result.fieldsChanged).toContain('logLevel');

      // Verify new config applied
      expect(reloader.getCurrentConfig().logLevel).toBe('debug');
      expect(configApplied).toHaveLength(1);
      expect(configApplied[0].logLevel).toBe('debug');

      // Verify scaler reload was called
      expect(deps.onScalerReload).toHaveBeenCalled();
    });
  });

  describe('4. Config rollback', () => {
    it('rolls back to a previous version, creating a new version with old content', async () => {
      const { db, state } = createMockDbForStore();
      const store = new SharedConfigStore(db, null);

      // Seed version 1
      const v1Config = {
        agentAuth: 'token' as const,
        queue: { maxDepth: 100 },
      };
      const v1 = await store.save(v1Config, 'cli:seed', 'Version 1');
      expect(v1).toBe(1);

      // Seed version 2 with different values
      const v2Config = {
        agentAuth: 'none' as const,
        queue: { maxDepth: 200 },
      };
      const v2 = await store.save(v2Config, 'cli:seed', 'Version 2');
      expect(v2).toBe(2);

      // Rollback to version 1
      const v3 = await store.rollback(1, 'cli:rollback');
      expect(v3).toBe(3);

      // Version 3 should have version 1's content
      const v3Row = state.rows.find((r) => r.version === 3);
      expect(v3Row).toBeDefined();
      expect(v3Row!.description).toBe('Rollback to version 1');
      expect(v3Row!.created_by).toBe('cli:rollback');

      // The config content should match version 1
      const v1Row = state.rows.find((r) => r.version === 1);
      expect(v3Row!.config).toBe(v1Row!.config);
    });

    it('throws when target version does not exist', async () => {
      const { db } = createMockDbForStore();
      const store = new SharedConfigStore(db, null);

      await expect(store.rollback(999, 'cli:rollback')).rejects.toThrow(
        'Config version 999 not found',
      );
    });
  });

  describe('5. Env var mapping', () => {
    it('only KICI_-prefixed vars are honored (P5: legacy unprefixed forms ignored)', () => {
      const yamlConfig = makeMinimalLocal();
      const dbConfig: SharedConfig = {
        agentAuth: 'token',
      };

      const env = {
        // KICI_ prefixed (canonical form)
        KICI_DATABASE_URL: 'postgres://kici-env',
        KICI_QUEUE_MAX_DEPTH: '2000',

        // Legacy unprefixed — no longer honored after P5 of the env-var
        // standardization plan.
        DATABASE_URL: 'postgres://legacy',
      };

      const result = resolveFullConfig(yamlConfig, dbConfig, env);

      // KICI_ env var wins; legacy is ignored
      expect(result.databaseUrl).toBe('postgres://kici-env');
      expect(result.queueMaxDepth).toBe(2000);
    });

    it('legacy DATABASE_URL / PLATFORM_URL / PLATFORM_TOKEN do not apply (P5)', () => {
      const yamlConfig = makeMinimalLocal();
      const dbConfig: SharedConfig = {
        agentAuth: 'token',
      };

      const env = {
        DATABASE_URL: 'postgres://legacy-only',
        PLATFORM_URL: 'ws://platform:4000/ws',
        PLATFORM_TOKEN: 'legacy-token',
      };

      const result = resolveFullConfig(yamlConfig, dbConfig, env);

      // P5 dropped the legacy forms — they fall through to YAML defaults.
      expect(result.databaseUrl).toBe('pg://integration-test');
      expect(result.platformUrl).toBeUndefined();
      expect(result.platformToken).toBeUndefined();
    });
  });

  describe('6. Restart-required field detection', () => {
    it('detects database.url change and preserves old value', async () => {
      const initialConfig = makeAppConfig({ databaseUrl: 'postgres://old/db' });
      const newConfig = makeAppConfig({ databaseUrl: 'postgres://new/db' });

      const deps: ConfigReloaderDeps = {
        resolveLocalConfig: vi.fn().mockResolvedValue({ local: {} }),
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
        sharedStore: null,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'http' });

      expect(result.success).toBe(true);
      expect(result.restartRequired).toContain('databaseUrl');
      // Old database URL preserved (not the new one)
      expect(reloader.getCurrentConfig().databaseUrl).toBe('postgres://old/db');
    });

    it('detects port change and preserves old value', async () => {
      const initialConfig = makeAppConfig({ port: 4000 });
      const newConfig = makeAppConfig({ port: 5000 });

      const deps: ConfigReloaderDeps = {
        resolveLocalConfig: vi.fn().mockResolvedValue({ local: {} }),
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
        sharedStore: null,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'http' });

      expect(result.success).toBe(true);
      expect(result.restartRequired).toContain('port');
      expect(reloader.getCurrentConfig().port).toBe(4000);
    });

    it('does not flag restart when only hot-reloadable fields change', async () => {
      const initialConfig = makeAppConfig({ logLevel: 'info' });
      const newConfig = makeAppConfig({ logLevel: 'debug', queueMaxDepth: 2000 });

      const deps: ConfigReloaderDeps = {
        resolveLocalConfig: vi.fn().mockResolvedValue({ local: {} }),
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
        sharedStore: null,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };

      const reloader = new ConfigReloader(initialConfig, deps);
      const result = await reloader.executeReload({ source: 'http' });

      expect(result.success).toBe(true);
      expect(result.restartRequired).toBeUndefined();
      expect(result.fieldsChanged).toContain('logLevel');
      expect(result.fieldsChanged).toContain('queueMaxDepth');
    });

    it('logs warning for restart-required fields', async () => {
      const initialConfig = makeAppConfig({ databaseUrl: 'postgres://old' });
      const newConfig = makeAppConfig({ databaseUrl: 'postgres://new' });
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      const deps: ConfigReloaderDeps = {
        resolveLocalConfig: vi.fn().mockResolvedValue({ local: {} }),
        resolveFullConfig: vi.fn().mockReturnValue(newConfig),
        sharedStore: null,
        logger,
      };

      const reloader = new ConfigReloader(initialConfig, deps);
      await reloader.executeReload({ source: 'http' });

      expect(logger.warn).toHaveBeenCalledWith(
        'Config fields changed but require restart to apply',
        expect.objectContaining({ fields: ['databaseUrl'] }),
      );
    });
  });
});
