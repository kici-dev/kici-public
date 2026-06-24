import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';

/**
 * Mirrors the agent and platform config tests. Wipes process.env back to a
 * known baseline at the start of each test (preserves originalEnv for
 * teardown), then sets the minimum required fields.
 */
describe('orchestrator loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('KICI_')) {
        delete process.env[key];
      }
    }
    // Minimum required for coordinator mode:
    process.env.KICI_MODE = 'platform';
    process.env.KICI_PLATFORM_URL = 'http://platform';
    process.env.KICI_PLATFORM_TOKEN = 'pt';
    process.env.KICI_DATABASE_URL = 'postgresql://test';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('newly-validated env vars (drift catcher)', () => {
    it('defaults autoMigrate to true when KICI_AUTO_MIGRATE unset', () => {
      const config = loadConfig();
      expect(config.autoMigrate).toBe(true);
    });

    it('parses KICI_AUTO_MIGRATE=false to autoMigrate=false', () => {
      process.env.KICI_AUTO_MIGRATE = 'false';
      const config = loadConfig();
      expect(config.autoMigrate).toBe(false);
    });

    it('coerces KICI_AGENT_MAX_RECONNECT_DELAY_MS', () => {
      process.env.KICI_AGENT_MAX_RECONNECT_DELAY_MS = '12345';
      const config = loadConfig();
      expect(config.agentMaxReconnectDelayMs).toBe(12345);
    });

    it('defaults agentMaxReconnectDelayMs to 60000', () => {
      const config = loadConfig();
      expect(config.agentMaxReconnectDelayMs).toBe(60_000);
    });

    it('defaults hostRebootDeadlineMs to 900000 (15 min)', () => {
      const config = loadConfig();
      expect(config.hostRebootDeadlineMs).toBe(900_000);
    });

    it('coerces KICI_HOST_REBOOT_DEADLINE_MS', () => {
      process.env.KICI_HOST_REBOOT_DEADLINE_MS = '120000';
      const config = loadConfig();
      expect(config.hostRebootDeadlineMs).toBe(120_000);
    });

    it('reads KICI_ORCHESTRATOR_HOST_AGENT_ID for the co-located guard', () => {
      process.env.KICI_ORCHESTRATOR_HOST_AGENT_ID = 'orch-box';
      const config = loadConfig();
      expect(config.orchestratorHostAgentId).toBe('orch-box');
    });

    it('parses KICI_SKIP_S3_SENTINEL_VALIDATION=true to true', () => {
      process.env.KICI_SKIP_S3_SENTINEL_VALIDATION = 'true';
      const config = loadConfig();
      expect(config.skipS3SentinelValidation).toBe(true);
    });

    it('defaults skipS3SentinelValidation to false', () => {
      const config = loadConfig();
      expect(config.skipS3SentinelValidation).toBe(false);
    });

    it('defaults user-cache quota and TTL when unset', () => {
      const config = loadConfig();
      expect(config.userCacheQuotaBytes).toBe(5 * 1024 * 1024 * 1024);
      expect(config.userCacheTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
      expect(config.storage?.userCacheQuotaBytes).toBe(5 * 1024 * 1024 * 1024);
      expect(config.storage?.userCacheTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('parses KICI_USER_CACHE_QUOTA_BYTES and KICI_USER_CACHE_TTL_MS', () => {
      process.env.KICI_USER_CACHE_QUOTA_BYTES = '12345';
      process.env.KICI_USER_CACHE_TTL_MS = '67890';
      const config = loadConfig();
      expect(config.userCacheQuotaBytes).toBe(12345);
      expect(config.userCacheTtlMs).toBe(67890);
      expect(config.storage?.userCacheQuotaBytes).toBe(12345);
      expect(config.storage?.userCacheTtlMs).toBe(67890);
    });
  });

  describe('superRefine cross-field rules survive defineEnv migration', () => {
    it('rejects coordinator mode when KICI_DATABASE_URL is missing', () => {
      delete process.env.KICI_DATABASE_URL;
      expect(() => loadConfig()).toThrow(/KICI_DATABASE_URL is required/);
    });

    it('accepts worker mode without KICI_DATABASE_URL or KICI_PLATFORM_URL', () => {
      delete process.env.KICI_DATABASE_URL;
      delete process.env.KICI_PLATFORM_URL;
      delete process.env.KICI_PLATFORM_TOKEN;
      process.env.KICI_CLUSTER_ROLE = 'worker';
      process.env.KICI_CLUSTER_COORDINATOR_URL = 'http://coord';
      const config = loadConfig();
      expect(config.cluster.role).toBe('worker');
      expect(config.cluster.coordinatorUrl).toBe('http://coord');
    });

    it('rejects worker mode without coordinator URL', () => {
      process.env.KICI_CLUSTER_ROLE = 'worker';
      expect(() => loadConfig()).toThrow(
        /KICI_CLUSTER_COORDINATOR_URL or KICI_CLUSTER_COORDINATOR_URLS is required/,
      );
    });

    it('accepts worker mode with KICI_CLUSTER_COORDINATOR_URLS (plural, comma-separated)', () => {
      process.env.KICI_CLUSTER_ROLE = 'worker';
      process.env.KICI_CLUSTER_COORDINATOR_URLS = 'http://a:10143,http://b:10243,http://c:10343';
      const config = loadConfig();
      expect(config.cluster.role).toBe('worker');
      expect(config.cluster.coordinatorUrls).toEqual([
        'http://a:10143',
        'http://b:10243',
        'http://c:10343',
      ]);
    });

    it('preserves singular KICI_CLUSTER_COORDINATOR_URL when plural is unset', () => {
      process.env.KICI_CLUSTER_ROLE = 'worker';
      process.env.KICI_CLUSTER_COORDINATOR_URL = 'http://only-coord:10143';
      const config = loadConfig();
      expect(config.cluster.coordinatorUrl).toBe('http://only-coord:10143');
      expect(config.cluster.coordinatorUrls).toEqual([]);
    });
  });

  describe('cluster nested env mapping', () => {
    it('reads KICI_CLUSTER_INSTANCE_ID into cluster.instanceId', () => {
      process.env.KICI_CLUSTER_INSTANCE_ID = 'orch-a';
      const config = loadConfig();
      expect(config.cluster.instanceId).toBe('orch-a');
    });

    it('parses KICI_CLUSTER_SINGLE_NODE=true to cluster.singleNode=true', () => {
      process.env.KICI_CLUSTER_SINGLE_NODE = 'true';
      const config = loadConfig();
      expect(config.cluster.singleNode).toBe(true);
    });

    it('defaults cluster.singleNode to false', () => {
      const config = loadConfig();
      expect(config.cluster.singleNode).toBe(false);
    });
  });

  describe('unknown-KICI-var rejection', () => {
    it('throws on a typo in a KICI_ env var (drift catcher)', () => {
      process.env.KICI_SECERT_KEY = 'oops';
      expect(() => loadConfig()).toThrow(/Unknown KICI_/);
    });

    it('downgrades unknown KICI_ vars to a warning when KICI_DEV=true', () => {
      process.env.KICI_SECERT_KEY = 'oops';
      process.env.KICI_DEV = 'true';
      expect(() => loadConfig()).not.toThrow();
    });
  });

  describe('KICI_STORAGE_UPLOAD_ENDPOINT', () => {
    it('parses into storage.uploadEndpoint for the s3 backend', () => {
      process.env.KICI_STORAGE_TYPE = 's3';
      process.env.KICI_STORAGE_BUCKET = 'kici-cache';
      process.env.KICI_STORAGE_ENDPOINT = 'http://seaweedfs:8333';
      process.env.KICI_STORAGE_UPLOAD_ENDPOINT = 'http://localhost:8333';
      process.env.KICI_STORAGE_EXTERNAL_ENDPOINT = 'http://host.docker.internal:8333';
      const config = loadConfig();
      expect(config.storage?.type).toBe('s3');
      expect(config.storage?.endpoint).toBe('http://seaweedfs:8333');
      expect(config.storage?.uploadEndpoint).toBe('http://localhost:8333');
      expect(config.storage?.externalEndpoint).toBe('http://host.docker.internal:8333');
    });
  });
});
