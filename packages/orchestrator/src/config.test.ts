import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';
import { DEFAULT_CACHE_STORAGE_S3_PREFIX, clusterSentinelKey } from './cluster/cluster-identity.js';

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

    it('provenance signing is off (issuer undefined) unless KICI_ORCHESTRATOR_PROVENANCE_ISSUER is set', () => {
      expect(loadConfig().provenanceSigningIssuer).toBeUndefined();
      process.env.KICI_ORCHESTRATOR_PROVENANCE_ISSUER = 'https://orch.example';
      const config = loadConfig();
      expect(config.provenanceSigningIssuer).toBe('https://orch.example');
      // kind is left unset here; the signer factory defaults it to `db`.
      expect(config.provenanceSignerKind).toBeUndefined();
    });

    it('reads the orchestrator signer custody knobs', () => {
      process.env.KICI_ORCHESTRATOR_PROVENANCE_ISSUER = 'https://orch.example';
      process.env.KICI_ORCHESTRATOR_SIGNER_KIND = 'command';
      process.env.KICI_ORCHESTRATOR_SIGNER_COMMAND = '/usr/local/bin/kici-signer';
      const config = loadConfig();
      expect(config.provenanceSignerKind).toBe('command');
      expect(config.provenanceSignerCommand).toBe('/usr/local/bin/kici-signer');
    });

    it('log segment flush thresholds default to 1MB / 2000ms and read KICI_LOG_STORAGE_* overrides', () => {
      const def = loadConfig();
      expect(def.logSegmentFlushBytes).toBe(1_048_576);
      expect(def.logSegmentFlushMs).toBe(2_000);

      process.env.KICI_LOG_STORAGE_SEGMENT_FLUSH_BYTES = '262144';
      process.env.KICI_LOG_STORAGE_SEGMENT_FLUSH_MS = '1000';
      const ov = loadConfig();
      expect(ov.logSegmentFlushBytes).toBe(262_144);
      expect(ov.logSegmentFlushMs).toBe(1_000);
    });

    it('agentBinarySource defaults unset (own cache bucket) and rejects an external HTTP(S) source', () => {
      expect(loadConfig().agentBinarySource).toBeUndefined();

      process.env.KICI_AGENT_BINARY_SOURCE = 's3://mirror-bucket/agent-packages';
      expect(loadConfig().agentBinarySource).toBe('s3://mirror-bucket/agent-packages');

      // No vendor CDN: an external HTTP(S) source is a config error.
      process.env.KICI_AGENT_BINARY_SOURCE = 'https://cdn.example.com/agent-packages';
      expect(() => loadConfig()).toThrow(/vendor CDN|external HTTP/i);
    });

    it('defaults dispatchQueueTtlDays to 30 and reads KICI_DISPATCH_QUEUE_TTL_DAYS', () => {
      expect(loadConfig().dispatchQueueTtlDays).toBe(30);
      process.env.KICI_DISPATCH_QUEUE_TTL_DAYS = '7';
      expect(loadConfig().dispatchQueueTtlDays).toBe(7);
    });

    describe('globalWorkflowsEnabled', () => {
      it('defaults to false', () => {
        expect(loadConfig().globalWorkflowsEnabled).toBe(false);
      });

      it('reads KICI_GLOBAL_WORKFLOWS_ENABLED=true as true', () => {
        process.env.KICI_GLOBAL_WORKFLOWS_ENABLED = 'true';
        expect(loadConfig().globalWorkflowsEnabled).toBe(true);
      });

      // The z.coerce.boolean() trap: any non-empty string coerces to true, so an
      // operator explicitly disabling the feature would silently enable it.
      it('reads the string "false" as false', () => {
        process.env.KICI_GLOBAL_WORKFLOWS_ENABLED = 'false';
        expect(loadConfig().globalWorkflowsEnabled).toBe(false);
      });

      it('reads an unrecognised string as false', () => {
        process.env.KICI_GLOBAL_WORKFLOWS_ENABLED = 'yes';
        expect(loadConfig().globalWorkflowsEnabled).toBe(false);
      });
    });

    // Regression guard. This knob is read at the reconnect state-replay send
    // site and was declared in no schema, so the unknown-KICI_*-var startup
    // guard made the orchestrator REFUSE TO BOOT whenever an operator set it —
    // turning the documented recovery knob into a way to take the service down.
    // Declaring it here is what makes the guard recognise the name.
    it('defaults reconnectReplayWindowHours to 24 and reads KICI_ORCH_RECONNECT_REPLAY_WINDOW_HOURS', () => {
      expect(loadConfig().reconnectReplayWindowHours).toBe(24);
      process.env.KICI_ORCH_RECONNECT_REPLAY_WINDOW_HOURS = '1';
      expect(loadConfig().reconnectReplayWindowHours).toBe(1);
    });

    it('defaults stepLogTtlDays to 90 and reads KICI_STEP_LOG_TTL_DAYS (0 disables)', () => {
      expect(loadConfig().stepLogTtlDays).toBe(90);
      process.env.KICI_STEP_LOG_TTL_DAYS = '0';
      expect(loadConfig().stepLogTtlDays).toBe(0);
    });

    it('defaults checkRunTrackingTtlDays to 7 and reads KICI_CHECK_RUN_TRACKING_TTL_DAYS (0 disables)', () => {
      expect(loadConfig().checkRunTrackingTtlDays).toBe(7);
      process.env.KICI_CHECK_RUN_TRACKING_TTL_DAYS = '0';
      expect(loadConfig().checkRunTrackingTtlDays).toBe(0);
    });

    it('rejects a fractional KICI_CHECK_RUN_TRACKING_TTL_DAYS rather than silently not sweeping', () => {
      // The sweep interpolates this into `make_interval(days => $1)`, which
      // Postgres rejects for a fractional value; the caller swallows that
      // error, so without this floor the table would grow unbounded and only
      // a log line would say so.
      process.env.KICI_CHECK_RUN_TRACKING_TTL_DAYS = '7.5';
      expect(() => loadConfig()).toThrow();
    });

    it('rejects a negative KICI_CHECK_RUN_TRACKING_TTL_DAYS', () => {
      process.env.KICI_CHECK_RUN_TRACKING_TTL_DAYS = '-1';
      expect(() => loadConfig()).toThrow();
    });

    it('parses KICI_AUTO_MIGRATE=false to autoMigrate=false', () => {
      process.env.KICI_AUTO_MIGRATE = 'false';
      const config = loadConfig();
      expect(config.autoMigrate).toBe(false);
    });

    it('defaults the ingest overflow buffer knobs (enabled, cap, replay pacing)', () => {
      const cfg = loadConfig();
      expect(cfg.ingestOverflowEnabled).toBe(true);
      expect(cfg.ingestOverflowMax).toBe(5000);
      expect(cfg.ingestOverflowReplayIntervalMs).toBe(2000);
      expect(cfg.ingestOverflowReplayBatch).toBe(50);
      expect(cfg.ingestOverflowMaxAttempts).toBe(10);
    });

    it('overrides ingest overflow knobs from KICI_INGEST_OVERFLOW_* env', () => {
      process.env.KICI_INGEST_OVERFLOW_ENABLED = 'false';
      process.env.KICI_INGEST_OVERFLOW_MAX = '100';
      process.env.KICI_INGEST_OVERFLOW_REPLAY_INTERVAL_MS = '500';
      process.env.KICI_INGEST_OVERFLOW_REPLAY_BATCH = '10';
      process.env.KICI_INGEST_OVERFLOW_MAX_ATTEMPTS = '3';
      const cfg = loadConfig();
      expect(cfg.ingestOverflowEnabled).toBe(false);
      expect(cfg.ingestOverflowMax).toBe(100);
      expect(cfg.ingestOverflowReplayIntervalMs).toBe(500);
      expect(cfg.ingestOverflowReplayBatch).toBe(10);
      expect(cfg.ingestOverflowMaxAttempts).toBe(3);
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

    it('defaults db pool max to 20, acquire timeout 5000, statement timeout 30000', () => {
      const config = loadConfig();
      expect(config.dbPoolMax).toBe(20);
      expect(config.dbPoolAcquireTimeoutMs).toBe(5_000);
      expect(config.dbStatementTimeoutMs).toBe(30_000);
    });

    it('reads KICI_DB_* pool overrides', () => {
      process.env.KICI_DB_POOL_MAX = '40';
      process.env.KICI_DB_POOL_ACQUIRE_TIMEOUT_MS = '2000';
      process.env.KICI_DB_STATEMENT_TIMEOUT_MS = '15000';
      const config = loadConfig();
      expect(config.dbPoolMax).toBe(40);
      expect(config.dbPoolAcquireTimeoutMs).toBe(2_000);
      expect(config.dbStatementTimeoutMs).toBe(15_000);
    });

    it('reads KICI_ORCHESTRATOR_HOST_AGENT_ID for the co-located guard', () => {
      process.env.KICI_ORCHESTRATOR_HOST_AGENT_ID = 'orch-box';
      const config = loadConfig();
      expect(config.orchestratorHostAgentId).toBe('orch-box');
    });

    it('defaults independentSecrets to false when KICI_INDEPENDENT_SECRETS unset', () => {
      const config = loadConfig();
      expect(config.independentSecrets).toBe(false);
    });

    it('parses KICI_INDEPENDENT_SECRETS=true to independentSecrets=true', () => {
      process.env.KICI_INDEPENDENT_SECRETS = 'true';
      const config = loadConfig();
      expect(config.independentSecrets).toBe(true);
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

    it('maps KICI_TEST_MINT_DEFER_AUDIENCE to testMintDeferAudience', () => {
      process.env.KICI_TEST_MODE = '1';
      process.env.KICI_TEST_MINT_DEFER_AUDIENCE = 'kici-provenance';
      const config = loadConfig();
      expect(config.testMode).toBe(true);
      expect(config.testMintDeferAudience).toBe('kici-provenance');
    });

    it('leaves testMintDeferAudience undefined when unset', () => {
      const config = loadConfig();
      expect(config.testMintDeferAudience).toBeUndefined();
    });

    it('maps KICI_TEST_MINT_REJECT_AUDIENCE to testMintRejectAudience', () => {
      process.env.KICI_TEST_MODE = '1';
      process.env.KICI_TEST_MINT_REJECT_AUDIENCE = 'kici-provenance-reject';
      const config = loadConfig();
      expect(config.testMode).toBe(true);
      expect(config.testMintRejectAudience).toBe('kici-provenance-reject');
    });

    it('leaves testMintRejectAudience undefined when unset', () => {
      const config = loadConfig();
      expect(config.testMintRejectAudience).toBeUndefined();
    });

    it('maps KICI_TEST_RERUN_DELAY_MS to testRerunDelayMs', () => {
      process.env.KICI_TEST_MODE = '1';
      process.env.KICI_TEST_RERUN_DELAY_MS = '4000';
      const config = loadConfig();
      expect(config.testMode).toBe(true);
      expect(config.testRerunDelayMs).toBe(4000);
    });

    it('leaves testRerunDelayMs undefined when unset', () => {
      const config = loadConfig();
      expect(config.testRerunDelayMs).toBeUndefined();
    });

    it('maps KICI_TEST_OMIT_DASHBOARD_REQUEST_TYPES to testOmitDashboardRequestTypes', () => {
      process.env.KICI_TEST_MODE = '1';
      process.env.KICI_TEST_OMIT_DASHBOARD_REQUEST_TYPES = 'dashboard.contexts.list';
      const config = loadConfig();
      expect(config.testMode).toBe(true);
      expect(config.testOmitDashboardRequestTypes).toBe('dashboard.contexts.list');
    });

    it('leaves testOmitDashboardRequestTypes undefined when unset', () => {
      const config = loadConfig();
      expect(config.testOmitDashboardRequestTypes).toBeUndefined();
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

  // Drift guard: the S3 storage prefix the orchestrator boots with (and thus the
  // cluster-identity sentinel key it validates) MUST match the shared
  // DEFAULT_CACHE_STORAGE_S3_PREFIX that the reconcile paths — the
  // `kici-admin cluster reconcile-identity` CLI and the staging deploy's
  // self-heal step — fall back to when KICI_STORAGE_PREFIX is unset. A drift
  // here (e.g. a hardcoded `kici-cache/` fallback) makes the reconcile step
  // anchor a different sentinel object than the one the orchestrator validates,
  // crash-looping the boot on a spurious "Cluster identity mismatch".
  describe('cache storage S3 prefix default (sentinel-drift guard)', () => {
    it('defaults storage.prefix to DEFAULT_CACHE_STORAGE_S3_PREFIX (bucket root)', () => {
      process.env.KICI_STORAGE_TYPE = 's3';
      process.env.KICI_STORAGE_BUCKET = 'kici-cache';
      const config = loadConfig();
      expect(config.storage?.prefix).toBe(DEFAULT_CACHE_STORAGE_S3_PREFIX);
      // The shared default resolves to the bucket-root sentinel key.
      expect(clusterSentinelKey(config.storage?.prefix)).toBe('.kici-cluster-id');
    });

    it('honors an explicit KICI_STORAGE_PREFIX override', () => {
      process.env.KICI_STORAGE_TYPE = 's3';
      process.env.KICI_STORAGE_BUCKET = 'kici-cache';
      process.env.KICI_STORAGE_PREFIX = 'tenant-a/';
      const config = loadConfig();
      expect(config.storage?.prefix).toBe('tenant-a/');
      expect(clusterSentinelKey(config.storage?.prefix)).toBe('tenant-a/.kici-cluster-id');
    });
  });

  describe('config validation scopes', () => {
    // The agent-packaging path (kici-admin agent package --upload and the
    // post-upgrade auto-refresh) runs in a shell without the orchestrator
    // runtime env, so it validates under the packaging scope.
    beforeEach(() => {
      // Strip the runtime coordinator/platform env so only storage config
      // remains — the exact shape an operator's upgrade shell carries.
      delete process.env.KICI_PLATFORM_URL;
      delete process.env.KICI_PLATFORM_TOKEN;
      delete process.env.KICI_DATABASE_URL;
      process.env.KICI_STORAGE_TYPE = 's3';
      process.env.KICI_STORAGE_BUCKET = 'kici-cache';
    });

    it('packaging scope accepts storage-only env without DB/platform runtime config', () => {
      const config = loadConfig('packaging');
      expect(config.storage?.type).toBe('s3');
      expect(config.storage?.bucket).toBe('kici-cache');
    });

    it('runtime scope still requires DB + platform fields', () => {
      let message = '';
      try {
        loadConfig();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/Configuration validation failed/);
      expect(message).toContain('KICI_DATABASE_URL is required for coordinator mode');
      expect(message).toContain(
        'KICI_PLATFORM_URL is required when KICI_MODE is platform, hybrid, or observed',
      );
      expect(message).toContain(
        'KICI_PLATFORM_TOKEN is required when KICI_MODE is platform, hybrid, or observed',
      );
    });

    it('packaging scope still enforces storage shape (S3 requires a bucket)', () => {
      delete process.env.KICI_STORAGE_BUCKET;
      expect(() => loadConfig('packaging')).toThrow(
        /KICI_STORAGE_BUCKET is required when KICI_STORAGE_TYPE is s3/,
      );
    });

    it('packaging scope skips the unknown-KICI_-var typo guard (arbitrary operator shell)', () => {
      // A packaging operation runs in a shell that may carry unrelated KICI_*
      // vars (test creds, operator tooling); the boot-time typo guard must not
      // block it.
      process.env.KICI_TEST_PASSWORD = 'shell-noise';
      process.env.KICI_SOME_OPERATOR_TOOL = '1';
      expect(() => loadConfig('packaging')).not.toThrow();
      const config = loadConfig('packaging');
      expect(config.storage?.type).toBe('s3');
    });

    it('runtime scope still rejects an unknown KICI_ var (typo guard active)', () => {
      // Restore the runtime env so only the unknown var is at fault.
      process.env.KICI_PLATFORM_URL = 'http://platform';
      process.env.KICI_PLATFORM_TOKEN = 'pt';
      process.env.KICI_DATABASE_URL = 'postgresql://test';
      process.env.KICI_TOTALLY_BOGUS_VAR = '1';
      expect(() => loadConfig()).toThrow(/Unknown KICI_\* env var/);
    });
  });

  describe('observed mode', () => {
    it('accepts KICI_MODE=observed with platform url/token and a webhook public url', () => {
      process.env.KICI_MODE = 'observed';
      process.env.KICI_WEBHOOK_PUBLIC_URL = 'https://orch.example';
      const config = loadConfig();
      expect(config.mode).toBe('observed');
      expect(config.webhookPublicUrl).toBe('https://orch.example');
    });

    it('rejects KICI_MODE=observed without the Platform connection', () => {
      process.env.KICI_MODE = 'observed';
      process.env.KICI_WEBHOOK_PUBLIC_URL = 'https://orch.example';
      delete process.env.KICI_PLATFORM_URL;
      delete process.env.KICI_PLATFORM_TOKEN;
      let message = '';
      try {
        loadConfig();
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain(
        'KICI_PLATFORM_URL is required when KICI_MODE is platform, hybrid, or observed',
      );
      expect(message).toContain(
        'KICI_PLATFORM_TOKEN is required when KICI_MODE is platform, hybrid, or observed',
      );
    });

    it('rejects KICI_MODE=observed without KICI_WEBHOOK_PUBLIC_URL', () => {
      process.env.KICI_MODE = 'observed';
      expect(() => loadConfig()).toThrow(
        /KICI_WEBHOOK_PUBLIC_URL is required when KICI_MODE is observed/,
      );
    });

    it('does not require KICI_WEBHOOK_PUBLIC_URL in hybrid mode', () => {
      process.env.KICI_MODE = 'hybrid';
      expect(() => loadConfig()).not.toThrow();
    });
  });

  describe('agent connect-back URL', () => {
    it('accepts KICI_ORCHESTRATOR_URL and surfaces it as orchestratorUrl', () => {
      // The unknown-KICI_-var guard refuses startup on any KICI_ name missing
      // from the envMap, so this one must stay declared: the bring-up and
      // scaler paths read it as the agents' cross-host connect-back URL.
      process.env.KICI_ORCHESTRATOR_URL = 'ws://10.67.0.1:10043/ws';
      const config = loadConfig();
      expect(config.orchestratorUrl).toBe('ws://10.67.0.1:10043/ws');
    });

    it('leaves orchestratorUrl undefined when unset (loopback fallback applies)', () => {
      delete process.env.KICI_ORCHESTRATOR_URL;
      expect(loadConfig().orchestratorUrl).toBeUndefined();
    });
  });
});
