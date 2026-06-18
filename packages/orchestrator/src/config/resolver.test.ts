import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// env-overlay functions
import {
  envKeyToConfigPath,
  applyEnvOverrides,
  deepMerge,
  deepSetByPath,
  deepGetByPath,
} from './env-overlay.js';

// resolver functions
import { resolveLocalConfig, resolveFullConfig, getDefaults } from './resolver.js';

import type { SharedConfig } from './types.js';

/** Create a temp directory for test config files */
async function createTmpDir(): Promise<string> {
  const dir = join(tmpdir(), `kici-resolver-test-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Minimal valid local config for independent mode (avoids platform validation).
 * Use this as a base for tests that don't care about providers/platform.
 */
function makeMinimalLocal(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    database: { url: 'pg://yaml' },
    instance: { mode: 'independent' },
    ...overrides,
  };
}

/**
 * Minimal valid shared config.
 */
function makeMinimalShared(overrides?: Partial<SharedConfig>): SharedConfig {
  return {
    agentAuth: 'token',
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// env-overlay.ts tests
// ──────────────────────────────────────────────────────────────────────────

describe('envKeyToConfigPath', () => {
  it('maps KICI_DATABASE_URL to database.url path', () => {
    expect(envKeyToConfigPath('KICI_DATABASE_URL')).toEqual(['database', 'url']);
  });

  it('maps KICI_SERVER_PORT to server.port path', () => {
    expect(envKeyToConfigPath('KICI_SERVER_PORT')).toEqual(['server', 'port']);
  });

  it('maps KICI_INSTANCE_MODE to instance.mode path', () => {
    expect(envKeyToConfigPath('KICI_INSTANCE_MODE')).toEqual(['instance', 'mode']);
  });

  it('maps KICI_PLATFORM_URL to platform.url path', () => {
    expect(envKeyToConfigPath('KICI_PLATFORM_URL')).toEqual(['platform', 'url']);
  });

  it('maps KICI_CLUSTER_JOIN_TOKEN to cluster.joinToken path', () => {
    expect(envKeyToConfigPath('KICI_CLUSTER_JOIN_TOKEN')).toEqual(['cluster', 'joinToken']);
  });

  it('maps KICI_CLUSTER_CREDENTIAL_FILE to cluster.credentialFile path', () => {
    expect(envKeyToConfigPath('KICI_CLUSTER_CREDENTIAL_FILE')).toEqual([
      'cluster',
      'credentialFile',
    ]);
  });

  it('maps KICI_CLUSTER_AUTO_ROTATE_CREDENTIALS to cluster.autoRotateCredentials path', () => {
    expect(envKeyToConfigPath('KICI_CLUSTER_AUTO_ROTATE_CREDENTIALS')).toEqual([
      'cluster',
      'autoRotateCredentials',
    ]);
  });

  it('maps KICI_CLUSTER_ROLE to cluster.role path', () => {
    expect(envKeyToConfigPath('KICI_CLUSTER_ROLE')).toEqual(['cluster', 'role']);
  });

  it('maps KICI_CLUSTER_COORDINATOR_URL to cluster.coordinatorUrl path', () => {
    expect(envKeyToConfigPath('KICI_CLUSTER_COORDINATOR_URL')).toEqual([
      'cluster',
      'coordinatorUrl',
    ]);
  });

  it('maps KICI_CLUSTER_PEER_STALE_TIMEOUT_MS to cluster.peerStaleTimeoutMs path', () => {
    expect(envKeyToConfigPath('KICI_CLUSTER_PEER_STALE_TIMEOUT_MS')).toEqual([
      'cluster',
      'peerStaleTimeoutMs',
    ]);
  });

  it('maps KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH to eventRouter.maxChainDepth path', () => {
    expect(envKeyToConfigPath('KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH')).toEqual([
      'eventRouter',
      'maxChainDepth',
    ]);
  });

  it('maps KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE to eventRouter path', () => {
    expect(envKeyToConfigPath('KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE')).toEqual([
      'eventRouter',
      'rateLimitPerWorkflowPerMinute',
    ]);
  });

  it('maps KICI_EVENT_ROUTER_EVENT_TTL_SECONDS to eventRouter.eventTtlSeconds path', () => {
    expect(envKeyToConfigPath('KICI_EVENT_ROUTER_EVENT_TTL_SECONDS')).toEqual([
      'eventRouter',
      'eventTtlSeconds',
    ]);
  });

  it('maps KICI_EVENT_ROUTER_CLEANUP_INTERVAL_MS to eventRouter.cleanupIntervalMs path', () => {
    expect(envKeyToConfigPath('KICI_EVENT_ROUTER_CLEANUP_INTERVAL_MS')).toEqual([
      'eventRouter',
      'cleanupIntervalMs',
    ]);
  });

  it('maps legacy unprefixed env vars used by startup loadConfig()', () => {
    // These are honored so env-var-only deployments can reload without
    // requiring every operator to also set KICI_-prefixed duplicates.
    // P3 of the env-var standardization plan removed PORT / BASE_PATH /
    // MODE — only the KICI_PORT / KICI_BASE_PATH / KICI_MODE forms are
    // accepted now (handled by the orchestrator envMap, not this map).
    // P5 removed DATABASE_URL / PLATFORM_URL / PLATFORM_TOKEN — only the
    // KICI_-prefixed forms work now. P6 removed LOG_LEVEL — only
    // KICI_LOG_LEVEL is accepted now. NODE_ENV is the only remaining
    // legacy mapping.
    expect(envKeyToConfigPath('DATABASE_URL')).toBeNull();
    expect(envKeyToConfigPath('PORT')).toBeNull();
    expect(envKeyToConfigPath('BASE_PATH')).toBeNull();
    expect(envKeyToConfigPath('MODE')).toBeNull();
    expect(envKeyToConfigPath('PLATFORM_URL')).toBeNull();
    expect(envKeyToConfigPath('PLATFORM_TOKEN')).toBeNull();
    expect(envKeyToConfigPath('LOG_LEVEL')).toBeNull();
    expect(envKeyToConfigPath('NODE_ENV')).toEqual(['nodeEnv']);
  });

  it('returns null for non-KICI_ env vars that are not in the legacy map', () => {
    expect(envKeyToConfigPath('FOO_BAR')).toBeNull();
    expect(envKeyToConfigPath('HOME')).toBeNull();
  });

  it('returns null for unknown KICI_ env var paths', () => {
    expect(envKeyToConfigPath('KICI_UNKNOWN_SETTING')).toBeNull();
  });
});

describe('deepMerge', () => {
  it('merges objects recursively', () => {
    const target = { a: { b: 1, c: 2 } };
    const source = { a: { b: 3 } };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: { b: 3, c: 2 } });
  });

  it('replaces arrays (does not merge item-by-item)', () => {
    const target = { arr: [1, 2, 3] };
    const source = { arr: [4, 5] };
    const result = deepMerge(target, source);
    expect(result).toEqual({ arr: [4, 5] });
  });

  it('does not override with undefined values', () => {
    const target = { a: 1, b: 2 };
    const source = { a: undefined, b: 3 };
    const result = deepMerge(target, source);
    expect(result.a).toBe(1);
    expect(result.b).toBe(3);
  });

  it('does not override with null values', () => {
    const target = { a: 'hello' };
    const source = { a: null };
    const result = deepMerge(target, source);
    expect(result.a).toBe('hello');
  });

  it('adds new keys from source', () => {
    const target = { a: 1 };
    const source = { b: 2 };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: 1, b: 2 });
  });
});

describe('deepSetByPath / deepGetByPath', () => {
  it('sets and gets nested values', () => {
    const obj: Record<string, unknown> = {};
    deepSetByPath(obj, ['a', 'b', 'c'], 42);
    expect(deepGetByPath(obj, ['a', 'b', 'c'])).toBe(42);
  });

  it('returns undefined for missing paths', () => {
    const obj = { a: 1 };
    expect(deepGetByPath(obj, ['a', 'b'])).toBeUndefined();
  });
});

describe('applyEnvOverrides', () => {
  it('overrides database.url from KICI_DATABASE_URL', () => {
    const config = { database: { url: 'pg://yaml' } };
    const env = { KICI_DATABASE_URL: 'pg://env' };
    const result = applyEnvOverrides(config, env);
    expect((result.database as Record<string, unknown>).url).toBe('pg://env');
  });

  it('overrides server.port from KICI_SERVER_PORT (coerced to number)', () => {
    const config = { server: { port: 4000 } };
    const env = { KICI_SERVER_PORT: '5000' };
    const result = applyEnvOverrides(config, env);
    expect((result.server as Record<string, unknown>).port).toBe(5000);
  });

  it('ignores non-KICI_ env vars', () => {
    const config = { database: { url: 'pg://yaml' } };
    // DATABASE_URL was removed from LEGACY_MAPPINGS in P5 — it is no
    // longer recognized; only KICI_DATABASE_URL applies.
    const env = { DATABASE_URL: 'pg://legacy', KICI_DATABASE_URL: 'pg://env' };
    const result = applyEnvOverrides(config, env);
    expect((result.database as Record<string, unknown>).url).toBe('pg://env');
  });

  it('ignores unknown KICI_ env vars', () => {
    const config = { database: { url: 'pg://yaml' } };
    const env = { KICI_UNKNOWN_SETTING: 'foo' };
    const result = applyEnvOverrides(config, env);
    // No crash, original config untouched
    expect((result.database as Record<string, unknown>).url).toBe('pg://yaml');
  });

  it('coerces KICI_PG_CUSTOMER_SECRETS to boolean', () => {
    const config = {};
    const envFalse = { KICI_PG_CUSTOMER_SECRETS: 'false' };
    const resultFalse = applyEnvOverrides(config, envFalse);
    expect(resultFalse.pgCustomerSecrets).toBe(false);

    const envTrue = { KICI_PG_CUSTOMER_SECRETS: 'true' };
    const resultTrue = applyEnvOverrides(config, envTrue);
    expect(resultTrue.pgCustomerSecrets).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// resolver.ts tests
// ──────────────────────────────────────────────────────────────────────────

describe('getDefaults', () => {
  it('returns default values for shared config fields', () => {
    const defaults = getDefaults();
    expect(defaults).toBeDefined();
    expect(typeof defaults).toBe('object');
  });
});

describe('resolveLocalConfig', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    // Save and clear relevant env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('KICI_')) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  });

  it('resolves database URL from YAML', async () => {
    const configPath = join(tmpDir, 'orchestrator.yaml');
    await writeFile(configPath, `database:\n  url: postgres://yaml@db:5432/kici\n`);

    const result = await resolveLocalConfig(configPath);
    expect(result.databaseUrl).toBe('postgres://yaml@db:5432/kici');
  });

  it('env var overrides YAML for database URL', async () => {
    const configPath = join(tmpDir, 'orchestrator.yaml');
    await writeFile(configPath, `database:\n  url: postgres://yaml@db:5432/kici\n`);
    process.env.KICI_DATABASE_URL = 'postgres://env@db:5432/kici';

    const result = await resolveLocalConfig(configPath);
    expect(result.databaseUrl).toBe('postgres://env@db:5432/kici');

    delete process.env.KICI_DATABASE_URL;
  });

  it('works with env-only mode (no YAML file)', async () => {
    process.env.KICI_DATABASE_URL = 'postgres://env-only@db:5432/kici';
    process.env.KICI_INSTANCE_MODE = 'independent';

    const result = await resolveLocalConfig();
    expect(result.databaseUrl).toBe('postgres://env-only@db:5432/kici');

    delete process.env.KICI_DATABASE_URL;
    delete process.env.KICI_INSTANCE_MODE;
  });
});

describe('resolveFullConfig', () => {
  it('precedence: env > YAML > DB > defaults', () => {
    const localConfig = makeMinimalLocal({ server: { port: 4000 } });
    const dbConfig = makeMinimalShared({
      queue: { maxDepth: 500 },
      lockfileCache: { max: 100 },
    });
    const env = { KICI_SERVER_PORT: '5000' };

    const result = resolveFullConfig(localConfig, dbConfig, env);

    // env overrides YAML for port
    expect(result.port).toBe(5000);
    // DB value used for queue settings
    expect(result.queueMaxDepth).toBe(500);
    // DB value used for lockfile cache
    expect(result.lockfileCacheMax).toBe(100);
  });

  it('env overrides DB for shared config fields', () => {
    const localConfig = makeMinimalLocal();
    const dbConfig = makeMinimalShared({
      platform: { url: 'wss://db-platform' },
    });
    const env = { KICI_PLATFORM_URL: 'wss://env-platform' };

    const result = resolveFullConfig(localConfig, dbConfig, env);
    expect(result.platformUrl).toBe('wss://env-platform');
  });

  it('uses YAML when env is empty', () => {
    const localConfig = makeMinimalLocal({ server: { port: 4000 } });
    const dbConfig = makeMinimalShared();

    const result = resolveFullConfig(localConfig, dbConfig, {});
    expect(result.port).toBe(4000);
    expect(result.databaseUrl).toBe('pg://yaml');
  });

  it('uses DB config when YAML and env are empty for shared fields', () => {
    const localConfig = makeMinimalLocal();
    const dbConfig: SharedConfig = {
      queue: { maxDepth: 500 },
      lockfileCache: { max: 200 },
    };

    const result = resolveFullConfig(localConfig, dbConfig, {});
    expect(result.queueMaxDepth).toBe(500);
    expect(result.lockfileCacheMax).toBe(200);
  });

  it('env KICI_SERVER_PORT=5000 overrides YAML server.port=4000', () => {
    const localConfig = makeMinimalLocal({ server: { port: 4000 } });
    const dbConfig = makeMinimalShared();

    const result = resolveFullConfig(localConfig, dbConfig, { KICI_SERVER_PORT: '5000' });
    expect(result.port).toBe(5000);
  });

  it('legacy DATABASE_URL is ignored (P5: only KICI_DATABASE_URL accepted)', () => {
    // P5 of the env-var standardization plan removed DATABASE_URL from the
    // legacy map — only KICI_DATABASE_URL is honored now.
    const localConfig = makeMinimalLocal();
    const dbConfig = makeMinimalShared();
    const env = { DATABASE_URL: 'pg://legacy' };

    const result = resolveFullConfig(localConfig, dbConfig, env);
    expect(result.databaseUrl).toBe('pg://yaml');
  });

  it('KICI_DATABASE_URL is the only accepted form', () => {
    const localConfig = makeMinimalLocal();
    const dbConfig = makeMinimalShared();
    // Even with both set, only KICI_DATABASE_URL applies — the legacy form
    // was removed from LEGACY_MAPPINGS in P5.
    const env = {
      DATABASE_URL: 'pg://legacy',
      KICI_DATABASE_URL: 'pg://kici',
    };

    const result = resolveFullConfig(localConfig, dbConfig, env);
    expect(result.databaseUrl).toBe('pg://kici');
  });

  it('valid config from env alone (no YAML, no DB)', () => {
    const localConfig = { database: { url: '' } }; // empty from env-only mode
    const env = {
      KICI_DATABASE_URL: 'pg://env',
      KICI_INSTANCE_MODE: 'independent',
    };

    const result = resolveFullConfig(localConfig, null, env);
    expect(result.databaseUrl).toBe('pg://env');
    expect(result.mode).toBe('independent');
  });

  it('applies defaults when no other layer provides a value', () => {
    const localConfig = makeMinimalLocal();
    const dbConfig = makeMinimalShared();

    const result = resolveFullConfig(localConfig, dbConfig, {});
    // Should have default values from getDefaults()
    expect(result.queueMaxDepth).toBe(1000);
    expect(result.queueTimeoutMs).toBe(3_600_000);
    expect(result.lockfileCacheMax).toBe(500);
    expect(result.agentAuth).toBe('token');
    expect(result.rosterGraceMs).toBe(300_000);
    expect(result.rosterTtlMs).toBe(1_800_000);
  });

  it('null DB config is handled gracefully', () => {
    const localConfig = makeMinimalLocal();
    const dbConfig = makeMinimalShared();
    const result = resolveFullConfig(localConfig, dbConfig, {});
    expect(result.databaseUrl).toBe('pg://yaml');
  });

  it('forwards cluster.role from merged config', () => {
    const localConfig = makeMinimalLocal({
      cluster: { role: 'worker', coordinatorUrl: 'http://coordinator:4000' },
    });
    const env = { KICI_DATABASE_URL: 'pg://env' };
    const result = resolveFullConfig(localConfig, null, env);
    expect(result.cluster.role).toBe('worker');
    expect(result.cluster.coordinatorUrl).toBe('http://coordinator:4000');
  });

  it('forwards cluster.peerStaleTimeoutMs from DB config', () => {
    const localConfig = makeMinimalLocal();
    const dbConfig = makeMinimalShared({
      cluster: { peerStaleTimeoutMs: 120_000 },
    });
    const result = resolveFullConfig(localConfig, dbConfig, {});
    expect(result.cluster.peerStaleTimeoutMs).toBe(120_000);
  });

  it('env KICI_CLUSTER_ROLE overrides YAML cluster.role', () => {
    const localConfig = makeMinimalLocal({
      cluster: { role: 'coordinator' },
    });
    const env = {
      KICI_CLUSTER_ROLE: 'worker',
      KICI_CLUSTER_COORDINATOR_URL: 'http://coord:4000',
    };
    const result = resolveFullConfig(localConfig, null, env);
    expect(result.cluster.role).toBe('worker');
    expect(result.cluster.coordinatorUrl).toBe('http://coord:4000');
  });

  it('flows KICI_SERVER_TLS_CERT_PATH through to appConfig.tlsCertPath', () => {
    const localConfig = makeMinimalLocal();
    const env = { KICI_SERVER_TLS_CERT_PATH: '/etc/ssl/kici.pem' };
    const result = resolveFullConfig(localConfig, null, env);
    expect(result.tlsCertPath).toBe('/etc/ssl/kici.pem');
  });

  it('reads server.tlsCertPath from YAML local config', () => {
    const localConfig = makeMinimalLocal({
      server: { tlsCertPath: '/etc/ssl/from-yaml.pem' },
    });
    const result = resolveFullConfig(localConfig, null, {});
    expect(result.tlsCertPath).toBe('/etc/ssl/from-yaml.pem');
  });

  it('tlsCertPath is undefined when not configured', () => {
    const localConfig = makeMinimalLocal();
    const result = resolveFullConfig(localConfig, null, {});
    expect(result.tlsCertPath).toBeUndefined();
  });

  it('defaults cluster.role to coordinator when not specified', () => {
    const localConfig = makeMinimalLocal();
    const result = resolveFullConfig(localConfig, null, {});
    expect(result.cluster.role).toBe('coordinator');
  });

  it('defaults cluster.peerStaleTimeoutMs to 60000 when not specified', () => {
    const localConfig = makeMinimalLocal();
    const result = resolveFullConfig(localConfig, null, {});
    expect(result.cluster.peerStaleTimeoutMs).toBe(60_000);
  });

  it('coerces KICI_CLUSTER_PEER_STALE_TIMEOUT_MS to number', () => {
    const localConfig = makeMinimalLocal();
    const env = { KICI_CLUSTER_PEER_STALE_TIMEOUT_MS: '90000' };
    const result = resolveFullConfig(localConfig, null, env);
    expect(result.cluster.peerStaleTimeoutMs).toBe(90_000);
  });

  it('defaults event router config when not specified', () => {
    const localConfig = makeMinimalLocal();
    const result = resolveFullConfig(localConfig, null, {});
    expect(result.eventRouterMaxChainDepth).toBe(10);
    expect(result.eventRouterRateLimitPerWorkflowPerMinute).toBe(100);
    expect(result.eventRouterEventTtlSeconds).toBe(604_800);
    expect(result.eventRouterCleanupIntervalMs).toBe(3_600_000);
  });

  it('env overrides event router config with numeric coercion', () => {
    const localConfig = makeMinimalLocal();
    const env = {
      KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH: '20',
      KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE: '50',
      KICI_EVENT_ROUTER_EVENT_TTL_SECONDS: '86400',
      KICI_EVENT_ROUTER_CLEANUP_INTERVAL_MS: '1800000',
    };
    const result = resolveFullConfig(localConfig, null, env);
    expect(result.eventRouterMaxChainDepth).toBe(20);
    expect(result.eventRouterRateLimitPerWorkflowPerMinute).toBe(50);
    expect(result.eventRouterEventTtlSeconds).toBe(86_400);
    expect(result.eventRouterCleanupIntervalMs).toBe(1_800_000);
  });

  it('DB config overrides defaults for event router', () => {
    const localConfig = makeMinimalLocal();
    const dbConfig = makeMinimalShared({
      eventRouter: { maxChainDepth: 5, rateLimitPerWorkflowPerMinute: 200 },
    });
    const result = resolveFullConfig(localConfig, dbConfig, {});
    expect(result.eventRouterMaxChainDepth).toBe(5);
    expect(result.eventRouterRateLimitPerWorkflowPerMinute).toBe(200);
    // Others still default
    expect(result.eventRouterEventTtlSeconds).toBe(604_800);
    expect(result.eventRouterCleanupIntervalMs).toBe(3_600_000);
  });

  it('env overrides DB for event router config', () => {
    const localConfig = makeMinimalLocal();
    const dbConfig = makeMinimalShared({
      eventRouter: { maxChainDepth: 5 },
    });
    const env = { KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH: '15' };
    const result = resolveFullConfig(localConfig, dbConfig, env);
    expect(result.eventRouterMaxChainDepth).toBe(15);
  });
});
