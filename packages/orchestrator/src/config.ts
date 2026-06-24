/**
 * Orchestrator configuration.
 *
 * This is a thin backward-compatible wrapper around the new config resolution
 * chain (config/resolver.ts). It preserves the existing synchronous loadConfig()
 * API so that no other files need changing.
 *
 * The new config system lives in config/ and supports:
 * - YAML config files (config/loader.ts)
 * - Shared DB config store (config/shared-store.ts)
 * - 4-layer resolution: env > YAML > DB > defaults (config/resolver.ts)
 * - KICI_ env var mapping (config/env-overlay.ts)
 *
 * Provider configuration (GitHub Apps, etc.) is managed via the `sources` table
 * and PgSecretStore, not through config. See SourceStore and SourceManager.
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineEnv, validateUnknownKiciVars, LOGGER_ENV_VARS } from '@kici-dev/shared/env';

const baseSchema = z.object({
  // Operating mode
  mode: z.enum(['platform', 'hybrid', 'independent']).default('platform'),
  // Server
  port: z.coerce.number().default(4000),
  basePath: z.string().default('/'),
  // TLS cert path for expiry diagnostic (optional)
  tlsCertPath: z.string().optional(),
  // Platform relay connection (required in platform/hybrid modes)
  platformUrl: z.string().optional(),
  platformToken: z.string().optional(),
  /**
   * Base URL of the user-facing dashboard. Used to build `details_url`
   * on GitHub Check Runs and similar outbound URLs that reach public
   * surfaces — the `oal_<12-char>` public alias is appended to this
   * base. When unset, no `details_url` is emitted (preserving today's
   * behavior). Trailing slash optional.
   */
  dashboardUrl: z.string().optional(),
  /**
   * Public base URL at which this orchestrator's own webhook ingress is
   * reachable (independent/hybrid self-serve generic webhooks:
   * `<base>/webhook/<customerId>/generic/<sourceId>`). Used by
   * `kici-admin source add` to print a generic source's webhook URL. GitHub-App
   * ingress is Platform-relayed, so GitHub URLs come from the Platform's
   * `source.register.ack`, not this value. Trailing slash optional.
   */
  webhookPublicUrl: z.string().optional(),
  // Database (PostgreSQL only — optional for worker role)
  databaseUrl: z.string().default(''),
  // Lockfile cache
  lockfileCacheMax: z.coerce.number().default(500),
  lockfileCacheTtlMs: z.coerce.number().default(3_600_000), // 1 hour
  // Dispatch queue
  queueMaxDepth: z.coerce.number().default(1000),
  queueTimeoutMs: z.coerce.number().default(3_600_000), // 1 hour, 0 = indefinite
  /**
   * Operator-facing backpressure warning threshold for the dispatch queue.
   * When pending-queue depth stays at or above this value for at least two
   * consecutive refresher ticks (~10s), the orchestrator emits a
   * `logger.warn` pointing operators at the per-label Grafana panel so
   * they can identify which label pool is starved. `0` disables the
   * warner entirely — metrics are still exported, but the periodic warn
   * is silenced. See docs/operator/monitoring.md for tuning guidance.
   */
  queueBackpressureThreshold: z.coerce.number().default(100),
  // Worker
  workerConcurrency: z.coerce.number().default(5),
  // Cap on how long the orchestrator's in-memory waiters map keeps a queued
  // concurrency entry parked before considering the agent's wait abandoned.
  // Mirrors the agent-side `KICI_CONCURRENCY_WAIT_TIMEOUT_MS` default; the
  // orchestrator currently uses this only for diagnostics — actual eviction
  // happens on agent disconnect via `cancelQueued`.
  concurrencyWaitTimeoutMs: z.coerce.number().int().min(1000).default(3_600_000),
  // Cluster-wide default for the dispatch-acknowledgment deadline: how long
  // the orchestrator waits for job.ack / job.reject / job.status running
  // after sending a job.dispatch before treating the dispatch as lost
  // (requeue + disconnect the agent). Per-org override in
  // org_settings.dispatch_ack_timeout_ms (set via kici-admin org-settings).
  dispatchAckTimeoutMs: z.coerce.number().int().min(1000).default(10_000),
  // Cache storage (for compiled bundle caching). Two backends:
  //   - s3:         pre-signed URLs, multi-host / production
  //   - filesystem: local files served via /api/v1/cache/blob/, single-host
  cacheStorageType: z.enum(['s3', 'filesystem']).optional(),
  cacheStoragePath: z.string().optional(), // legacy, used for log storage filesystem fallback
  cacheStorageS3Bucket: z.string().optional(), // S3 only
  cacheStorageS3Prefix: z.string().default('kici-cache/'), // S3 only
  cacheStorageS3Region: z.string().optional(), // S3 only
  cacheStorageS3Endpoint: z.string().optional(), // S3-compatible endpoint (SeaweedFS, LocalStack)
  cacheStorageS3ExternalEndpoint: z.string().optional(), // Separate endpoint for pre-signed URLs (agents)
  cacheStorageS3UploadEndpoint: z.string().optional(), // Host-facing endpoint for CLI pre-signed uploads
  cacheStorageS3ForcePathStyle: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(), // Path-style access for S3-compatible services
  // Filesystem backend: absolute base directory for cached blobs. Required
  // when cacheStorageType === 'filesystem'.
  cacheStorageFsPath: z.string().optional(),
  // Filesystem backend: base URL the agent uses to reach this orchestrator
  // (e.g., http://orch.local:10143). Used to mint signed blob-route URLs.
  // When unset, derived from the orchestrator's bind host:port at boot.
  cacheStorageFsBaseUrl: z.string().optional(),
  logStorageS3Bucket: z.string().optional(), // Separate bucket for logs (defaults to cache bucket)
  cacheTtlDays: z.coerce.number().default(30), // TTL in days (minimum 30)
  cacheBuildTimeoutMs: z.coerce.number().default(600_000), // 10 min build timeout
  cacheMaxTarballBytes: z.coerce.number().default(524_288_000), // Max dep tarball size (500MB)
  // User-facing cache (ctx.cache / declarative job/step cache). Per-org byte
  // quota and per-entry TTL for the UserCache layer. Defaults: 5 GiB / 7 days.
  userCacheQuotaBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024 * 1024)
    .describe(
      'Cluster-wide default per-org byte quota for the user-facing cache (ctx.cache). ' +
        'A per-org override in org_settings.user_cache_quota_bytes (set via ' +
        '`kici-admin org-settings user-cache set-quota`) takes precedence when present.',
    ),
  userCacheTtlMs: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60 * 1000)
    .describe(
      'Cluster-wide default per-entry TTL (ms) for the user-facing cache. ' +
        'A per-org override in org_settings.user_cache_ttl_ms (set via ' +
        '`kici-admin org-settings user-cache set-ttl`) takes precedence when present.',
    ),
  // Webhook payload storage (optional -- if set, writes raw payloads to this directory)
  webhookPayloadDir: z.string().optional(),
  // Orchestrator data root for execution-log/cache storage (optional). When
  // unset, resolves /var/lib/kici if writable, else ${XDG_STATE_HOME:-$HOME/
  // .local/state}/kici — so a user-level install works without root-owned
  // /var/lib/kici. KICI_WEBHOOK_PAYLOAD_DIR still overrides the log base.
  dataDir: z.string().optional(),
  // Scaler (optional -- if neither is set, scaler is not enabled)
  scalerConfigPath: z.string().optional(),
  scalerConfigDir: z.string().optional(),
  // Machine-wide resource ledger directory used by named machine pools.
  // The ledger is a small JSON file per pool, coordinated across processes via
  // an atomic mkdir-based directory lock. Default: /var/lib/kici/scaler-ledger.
  // Falls back to ${XDG_STATE_HOME:-$HOME/.local/state}/kici/scaler-ledger when
  // the default path is not writable.
  machineLedgerDir: z.string().optional(),
  // Stale detection
  staleDetectorScanIntervalMs: z.coerce.number().default(60_000),
  staleDetectorThresholdMultiplier: z.coerce.number().default(2),
  jobHeartbeatIntervalMs: z.coerce.number().default(60_000),
  // GitHub App name/slug refresh — how often the orchestrator re-fetches every
  // GitHub source's display name + slug from GitHub (`GET /app`) and re-registers
  // it if it drifted. Default: 24h.
  githubAppNameRefreshIntervalMs: z.coerce.number().default(86_400_000),
  // Secrets management (optional -- enables encrypted secret store + admin API)
  secretKey: z.string().optional(), // KICI_SECRET_KEY (hex-encoded or base64 32-byte key)
  secretKeyFile: z.string().optional(), // KICI_SECRET_KEY_FILE (path to key file)
  secretKeyOld: z.string().optional(), // KICI_SECRET_KEY_OLD (previous key for rotation)
  secretKeyFileOld: z.string().optional(), // KICI_SECRET_KEY_FILE_OLD (path to previous key file)
  bootstrapAdminToken: z.string().optional(), // KICI_BOOTSTRAP_ADMIN_TOKEN
  // PG customer secrets toggle (default: true)
  pgCustomerSecrets: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Agent authentication
  agentAuth: z.enum(['token', 'none']).default('token'),
  agentTokenTtlMs: z.coerce.number().default(3_600_000), // 1 hour default TTL for ephemeral agent tokens
  // Host roster (declared inventory) timing knobs (cluster-wide defaults)
  rosterGraceMs: z.coerce.number().int().min(1000).default(300_000), // 5 min — static grace before unreachable
  rosterTtlMs: z.coerce.number().int().min(1000).default(1_800_000), // 30 min — ephemeral GC ttl
  // Cluster-wide default deadline for a workflow-initiated host reboot to
  // complete its down-then-up cycle. Replaces the short recovery window for a
  // reboot-pending host; the held post-restart job fails on expiry. Authors
  // override per-restart via `restartHost({ deadlineMs })`.
  hostRebootDeadlineMs: z.coerce.number().int().min(1000).default(900_000), // 15 min
  // Co-located guard for workflow-level host restart: the agentId of an agent
  // that shares this orchestrator's host. A `restartHost()` request from that
  // agent is refused so the orchestrator can never reboot its own box. Empty =
  // no co-located agent.
  orchestratorHostAgentId: z.string().optional(),
  maxFanoutHosts: z.coerce.number().int().min(1).default(1024), // cap on runsOnAll per-host children
  // Event router
  eventRouterMaxChainDepth: z.coerce.number().default(10),
  eventRouterRateLimitPerWorkflowPerMinute: z.coerce.number().default(100),
  eventRouterEventTtlSeconds: z.coerce.number().default(604_800), // 7 days
  eventRouterCleanupIntervalMs: z.coerce.number().default(3_600_000), // 1 hour
  // Event delivery retry / DLQ knobs (added with at-least-once dispatch).
  // Defaults match `DEFAULT_EVENT_ROUTER_CONFIG` in events/types.ts; bumping
  // either here OR in code requires bumping both to keep parity.
  eventRouterMaxDispatchAttempts: z.coerce.number().default(5),
  eventRouterLeaseDurationMs: z.coerce.number().default(60_000),
  eventRouterRetryBaseBackoffMs: z.coerce.number().default(5_000),
  eventRouterRetryMaxBackoffMs: z.coerce.number().default(300_000),
  eventRouterRetryScanIntervalMs: z.coerce.number().default(10_000),
  /**
   * **Test-only.** Master switch for fault-injection knobs in the event
   * dispatch pipeline. When `false` (default) the orchestrator ignores
   * every test-only knob below, even if its env var is set. Pair with
   * `KICI_TEST_EVENT_FAIL_FIRST_N` to drive the E2E retry / DLQ
   * scenarios. Production deployments leave this at its default.
   */
  testMode: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v.toLowerCase() === 'true'),
  /**
   * **Test-only.** JSON map of `{ "<eventName>": <N> }` instructing the
   * EventRouter to throw a synthetic dispatch error while
   * `event.attempts <= N`. Ignored unless `KICI_TEST_MODE=1`.
   */
  testEventFailFirstN: z.string().optional(),
  // Inbound webhook delivery log (event_log table). Default soft-cap 5MB.
  // Phase E retired the row TTL: rows are now archived to cold-store after
  // 30 days rather than hard-deleted. Oversized payloads are still recorded
  // with payload_omitted=true rather than 413'd.
  eventLogMaxPayloadBytes: z.coerce.number().default(5 * 1024 * 1024),
  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  // Migrations / boot
  autoMigrate: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  // Agent recovery (used by Dispatcher to bound how long it waits for a
  // disconnected agent to come back before failing in-flight jobs).
  agentMaxReconnectDelayMs: z.coerce.number().default(60_000),
  // S3 sentinel validation (escape hatch for E2E fault-injection tests).
  skipS3SentinelValidation: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // OpenTelemetry exporter endpoint (consumed by initTelemetry).
  otelExporterOtlpEndpoint: z.string().optional(),
  // Optional first-boot seed for the orchestrator's cluster_name (the
  // human-friendly identifier surfaced to Platform). Only honored when
  // the `cluster_meta.cluster_name` row is missing; subsequent boots
  // ignore the env var in favor of the stored value. See
  // `packages/orchestrator/src/config/cluster-name.ts` for the
  // resolution order. Registered here so the env-var validator knows
  // about the name; the resolver still reads it directly from
  // `process.env` because it runs before the config object is exposed.
  clusterName: z.string().optional(),
  // Cluster mode (multi-orchestrator coordination)
  cluster: z
    .object({
      /** This orchestrator's unique instance ID. Default: random UUID. */
      instanceId: z
        .string()
        .optional()
        .default(() => randomUUID()),
      /** This orchestrator's address for peers to connect to. Required when peers are configured. */
      address: z.string().optional(),
      /** Join token for cluster bootstrap. */
      joinToken: z.string().optional(),
      /** Path to peer credential file. */
      credentialFile: z.string().default('~/.kici/peer-credential'),
      /** Auto-rotate credentials. */
      autoRotateCredentials: z.boolean().default(false),
      /** Static peer addresses for independent mode. Comma-separated URLs. */
      peers: z
        .string()
        .optional()
        .transform((v) => (v ? v.split(',').map((s) => s.trim()) : [])),
      /** Raft election timeout minimum in ms. Default: 5000. */
      raftElectionTimeoutMinMs: z.coerce.number().default(5000),
      /** Raft election timeout maximum in ms. Default: 10000. */
      raftElectionTimeoutMaxMs: z.coerce.number().default(10000),
      /** Raft leader heartbeat interval in ms. Default: 2000. */
      raftHeartbeatMs: z.coerce.number().default(2000),
      /** Peer heartbeat interval in ms (inventory broadcast). Default: 30000. */
      peerHeartbeatIntervalMs: z.coerce.number().default(30000),
      /** Maximum peer reconnect delay in ms. Default: 60000. */
      peerMaxReconnectDelayMs: z.coerce.number().default(60000),
      /** Cluster role: coordinator (full orchestrator) or worker (delegated execution). Default: coordinator. */
      role: z.enum(['coordinator', 'worker']).default('coordinator'),
      /** URL of the coordinator to connect to when role=worker. Single-coord mode. */
      coordinatorUrl: z.string().optional(),
      /**
       * URLs of all coordinators to connect to when role=worker (comma-separated).
       * Worker maintains one outbound PeerClient per coord so every coord can
       * route work to it. Takes precedence over coordinatorUrl when both are set.
       */
      coordinatorUrls: z
        .string()
        .optional()
        .transform((v) =>
          v
            ? v
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
        ),
      /** Stale peer timeout in ms (2 missed heartbeats at 30s = 60s default). */
      peerStaleTimeoutMs: z.coerce.number().default(60_000),
      /** Grace period before dormant-mode self-election (0 peers). Default: 60000ms.
       *  Prevents false self-election during the peer discovery window. */
      electionGracePeriodMs: z.coerce.number().default(60_000),
      /** Single-node deployment mode. When true, election grace period is bypassed
       *  for immediate self-election. Default: false. */
      singleNode: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : v === 'true')),
      /** Trusted proxy IPs/CIDRs for X-Forwarded-For/X-Real-IP extraction. Comma-separated. */
      trustedProxies: z
        .string()
        .default('')
        .transform((v) => (v ? v.split(',').map((s) => s.trim()) : [])),
    })
    .prefault({}),
});

const configSchema = baseSchema.superRefine((data, ctx) => {
  const isWorker = data.cluster.role === 'worker';

  // Workers require at least one coordinator URL (singular or plural form).
  if (
    isWorker &&
    !data.cluster.coordinatorUrl &&
    (!data.cluster.coordinatorUrls || data.cluster.coordinatorUrls.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'KICI_CLUSTER_COORDINATOR_URL or KICI_CLUSTER_COORDINATOR_URLS is required when KICI_CLUSTER_ROLE=worker',
      path: ['cluster', 'coordinatorUrls'],
    });
  }

  // KICI_DATABASE_URL is required for coordinator mode (workers don't need it)
  if (!isWorker && !data.databaseUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'KICI_DATABASE_URL is required for coordinator mode',
      path: ['databaseUrl'],
    });
  }

  // Platform/hybrid modes require relay connection (skip for workers — they don't connect to Platform)
  if (!isWorker && (data.mode === 'platform' || data.mode === 'hybrid')) {
    if (!data.platformUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'KICI_PLATFORM_URL is required when KICI_MODE is platform or hybrid',
        path: ['platformUrl'],
      });
    }
    if (!data.platformToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'KICI_PLATFORM_TOKEN is required when KICI_MODE is platform or hybrid',
        path: ['platformToken'],
      });
    }
  }
  // Cache: S3 type requires bucket
  if (data.cacheStorageType === 's3' && !data.cacheStorageS3Bucket) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'KICI_STORAGE_BUCKET is required when KICI_STORAGE_TYPE is s3',
      path: ['cacheStorageS3Bucket'],
    });
  }
  // Cache: filesystem type requires an absolute base path
  if (data.cacheStorageType === 'filesystem') {
    if (!data.cacheStorageFsPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'KICI_STORAGE_FS_PATH is required when KICI_STORAGE_TYPE is filesystem',
        path: ['cacheStorageFsPath'],
      });
    } else if (!data.cacheStorageFsPath.startsWith('/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'KICI_STORAGE_FS_PATH must be an absolute path',
        path: ['cacheStorageFsPath'],
      });
    }
  }
  // Cluster validation: address required when peers are explicitly configured
  if (data.cluster.peers.length > 0 && !data.cluster.address) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'KICI_CLUSTER_ADDRESS is required when KICI_CLUSTER_PEERS is set (peers need to know where to connect back)',
      path: ['cluster', 'address'],
    });
  }
});

/**
 * App configuration type. Includes computed instanceId for multi-instance support.
 *
 * Provider configuration (GitHub Apps) is now managed via the sources table
 * and SourceManager, not through config.
 */
export type AppConfig = z.infer<typeof configSchema> & {
  /** Unique identifier for this orchestrator instance, generated at startup */
  instanceId: string;
  /** Object storage settings (populated from legacy env vars or SharedConfig) */
  storage?: {
    type?: 's3' | 'filesystem';
    bucket?: string;
    prefix?: string;
    region?: string;
    endpoint?: string;
    externalEndpoint?: string;
    uploadEndpoint?: string;
    forcePathStyle?: boolean;
    logBucket?: string;
    /** Filesystem backend: absolute base directory for cached blobs. */
    fsBasePath?: string;
    /** Filesystem backend: base URL the agent uses to reach this orchestrator. */
    fsBaseUrl?: string;
    /** Per-org byte quota for the user-facing cache (UserCache). */
    userCacheQuotaBytes?: number;
    /** Per-entry TTL (ms) for the user-facing cache (UserCache). */
    userCacheTtlMs?: number;
  };
};

/**
 * Env-var definition for the orchestrator. Exported so the docs generator and
 * the deploy-stg pre-validator can re-parse without going through process.env.
 *
 * Note: passes the inner `baseSchema` (a ZodObject) so describe() can walk
 * `.shape`, but uses the outer `configSchema` (with .superRefine) as the parser
 * so cross-field rules still fire.
 */
export const envDef = defineEnv({
  service: 'orchestrator',
  schema: baseSchema,
  parser: configSchema,
  envMap: {
    mode: 'KICI_MODE',
    port: 'KICI_PORT',
    basePath: 'KICI_BASE_PATH',
    tlsCertPath: 'KICI_SERVER_TLS_CERT_PATH',
    platformUrl: 'KICI_PLATFORM_URL',
    platformToken: 'KICI_PLATFORM_TOKEN',
    dashboardUrl: 'KICI_DASHBOARD_URL',
    webhookPublicUrl: 'KICI_WEBHOOK_PUBLIC_URL',
    databaseUrl: 'KICI_DATABASE_URL',
    cacheStorageType: 'KICI_STORAGE_TYPE',
    cacheStoragePath: 'KICI_STORAGE_PATH',
    cacheStorageS3Bucket: 'KICI_STORAGE_BUCKET',
    cacheStorageS3Prefix: 'KICI_STORAGE_PREFIX',
    cacheStorageS3Region: 'KICI_STORAGE_REGION',
    cacheStorageS3Endpoint: 'KICI_STORAGE_ENDPOINT',
    cacheStorageS3ExternalEndpoint: 'KICI_STORAGE_EXTERNAL_ENDPOINT',
    cacheStorageS3UploadEndpoint: 'KICI_STORAGE_UPLOAD_ENDPOINT',
    cacheStorageS3ForcePathStyle: 'KICI_STORAGE_FORCE_PATH_STYLE',
    cacheStorageFsPath: 'KICI_STORAGE_FS_PATH',
    cacheStorageFsBaseUrl: 'KICI_STORAGE_FS_BASE_URL',
    logStorageS3Bucket: 'KICI_STORAGE_LOG_BUCKET',
    cacheTtlDays: 'KICI_CACHE_TTL_DAYS',
    cacheBuildTimeoutMs: 'KICI_CACHE_BUILD_TIMEOUT_MS',
    cacheMaxTarballBytes: 'KICI_CACHE_MAX_TARBALL_BYTES',
    userCacheQuotaBytes: 'KICI_USER_CACHE_QUOTA_BYTES',
    userCacheTtlMs: 'KICI_USER_CACHE_TTL_MS',
    lockfileCacheMax: 'KICI_LOCKFILE_CACHE_MAX',
    lockfileCacheTtlMs: 'KICI_LOCKFILE_CACHE_TTL_MS',
    queueMaxDepth: 'KICI_QUEUE_MAX_DEPTH',
    queueTimeoutMs: 'KICI_QUEUE_TIMEOUT_MS',
    queueBackpressureThreshold: 'KICI_QUEUE_BACKPRESSURE_THRESHOLD',
    workerConcurrency: 'KICI_WORKER_CONCURRENCY',
    concurrencyWaitTimeoutMs: 'KICI_CONCURRENCY_WAIT_TIMEOUT_MS',
    dispatchAckTimeoutMs: 'KICI_DISPATCH_ACK_TIMEOUT_MS',
    webhookPayloadDir: 'KICI_WEBHOOK_PAYLOAD_DIR',
    dataDir: 'KICI_DATA_DIR',
    scalerConfigPath: 'KICI_SCALER_CONFIG_PATH',
    scalerConfigDir: 'KICI_SCALER_CONFIG_DIR',
    machineLedgerDir: 'KICI_MACHINE_LEDGER_DIR',
    staleDetectorScanIntervalMs: 'KICI_STALE_DETECTOR_SCAN_INTERVAL_MS',
    staleDetectorThresholdMultiplier: 'KICI_STALE_DETECTOR_THRESHOLD_MULTIPLIER',
    jobHeartbeatIntervalMs: 'KICI_JOB_HEARTBEAT_INTERVAL_MS',
    githubAppNameRefreshIntervalMs: 'KICI_GITHUB_APP_NAME_REFRESH_INTERVAL_MS',
    secretKey: 'KICI_SECRET_KEY',
    secretKeyFile: 'KICI_SECRET_KEY_FILE',
    secretKeyOld: 'KICI_SECRET_KEY_OLD',
    secretKeyFileOld: 'KICI_SECRET_KEY_FILE_OLD',
    bootstrapAdminToken: 'KICI_BOOTSTRAP_ADMIN_TOKEN',
    pgCustomerSecrets: 'KICI_PG_CUSTOMER_SECRETS',
    agentAuth: 'KICI_AGENT_AUTH',
    agentTokenTtlMs: 'KICI_AGENT_TOKEN_TTL_MS',
    rosterGraceMs: 'KICI_ROSTER_GRACE_MS',
    rosterTtlMs: 'KICI_ROSTER_TTL_MS',
    hostRebootDeadlineMs: 'KICI_HOST_REBOOT_DEADLINE_MS',
    orchestratorHostAgentId: 'KICI_ORCHESTRATOR_HOST_AGENT_ID',
    maxFanoutHosts: 'KICI_MAX_FANOUT_HOSTS',
    eventRouterMaxChainDepth: 'KICI_EVENT_ROUTER_MAX_CHAIN_DEPTH',
    eventRouterRateLimitPerWorkflowPerMinute:
      'KICI_EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE',
    eventRouterEventTtlSeconds: 'KICI_EVENT_ROUTER_EVENT_TTL_SECONDS',
    eventRouterCleanupIntervalMs: 'KICI_EVENT_ROUTER_CLEANUP_INTERVAL_MS',
    eventRouterMaxDispatchAttempts: 'KICI_EVENT_ROUTER_MAX_DISPATCH_ATTEMPTS',
    eventRouterLeaseDurationMs: 'KICI_EVENT_ROUTER_LEASE_DURATION_MS',
    eventRouterRetryBaseBackoffMs: 'KICI_EVENT_ROUTER_RETRY_BASE_BACKOFF_MS',
    eventRouterRetryMaxBackoffMs: 'KICI_EVENT_ROUTER_RETRY_MAX_BACKOFF_MS',
    eventRouterRetryScanIntervalMs: 'KICI_EVENT_ROUTER_RETRY_SCAN_INTERVAL_MS',
    testMode: 'KICI_TEST_MODE',
    testEventFailFirstN: 'KICI_TEST_EVENT_FAIL_FIRST_N',
    eventLogMaxPayloadBytes: 'KICI_EVENT_LOG_MAX_PAYLOAD_BYTES',
    logLevel: 'KICI_LOG_LEVEL',
    nodeEnv: 'NODE_ENV',
    autoMigrate: 'KICI_AUTO_MIGRATE',
    agentMaxReconnectDelayMs: 'KICI_AGENT_MAX_RECONNECT_DELAY_MS',
    skipS3SentinelValidation: 'KICI_SKIP_S3_SENTINEL_VALIDATION',
    otelExporterOtlpEndpoint: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    clusterName: 'KICI_CLUSTER_NAME',
    cluster: {
      instanceId: 'KICI_CLUSTER_INSTANCE_ID',
      address: 'KICI_CLUSTER_ADDRESS',
      joinToken: 'KICI_CLUSTER_JOIN_TOKEN',
      credentialFile: 'KICI_CLUSTER_CREDENTIAL_FILE',
      peers: 'KICI_CLUSTER_PEERS',
      raftElectionTimeoutMinMs: 'KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MIN_MS',
      raftElectionTimeoutMaxMs: 'KICI_CLUSTER_RAFT_ELECTION_TIMEOUT_MAX_MS',
      raftHeartbeatMs: 'KICI_CLUSTER_RAFT_HEARTBEAT_MS',
      peerHeartbeatIntervalMs: 'KICI_CLUSTER_PEER_HEARTBEAT_INTERVAL_MS',
      peerMaxReconnectDelayMs: 'KICI_CLUSTER_PEER_MAX_RECONNECT_DELAY_MS',
      role: 'KICI_CLUSTER_ROLE',
      coordinatorUrl: 'KICI_CLUSTER_COORDINATOR_URL',
      coordinatorUrls: 'KICI_CLUSTER_COORDINATOR_URLS',
      peerStaleTimeoutMs: 'KICI_CLUSTER_PEER_STALE_TIMEOUT_MS',
      electionGracePeriodMs: 'KICI_CLUSTER_ELECTION_GRACE_PERIOD_MS',
      singleNode: 'KICI_CLUSTER_SINGLE_NODE',
      trustedProxies: 'KICI_CLUSTER_TRUSTED_PROXIES',
    },
  },
});

/**
 * Load orchestrator configuration from environment variables.
 *
 * This is the LEGACY synchronous config loader. It reads directly from process.env
 * using the env var names declared in `envDef` (KICI_DATABASE_URL, KICI_PORT, etc.).
 *
 * Provider configuration (GitHub Apps) is no longer loaded from env vars.
 * Use the sources table and SourceManager instead.
 *
 * For new deployments, use resolveLocalConfig() + resolveFullConfig() from
 * config/resolver.ts which support YAML files, KICI_ env var prefixes, and
 * the shared DB config store.
 */
/**
 * Cold-store env vars consumed by `OrchestratorColdStore` directly via
 * `process.env` (not threaded through the AppConfig schema). Registered
 * here so the unknown-KICI_* validator at boot doesn't reject them.
 * Per-table tuning mirrors `knownTables` in `orchestrator-cold-store.ts`.
 */
const COLD_STORE_ENV_VARS = [
  'KICI_COLD_STORE_ENABLED',
  'KICI_COLD_STORE_BUCKET',
  'KICI_COLD_STORE_PREFIX',
  'KICI_COLD_STORE_REGION',
  'KICI_COLD_STORE_ENDPOINT',
  'KICI_COLD_STORE_EXTERNAL_ENDPOINT',
  'KICI_COLD_STORE_FORCE_PATH_STYLE',
  'KICI_COLD_STORE_S3_CONCURRENCY',
  'KICI_COLD_STORE_EXECUTION_RUNS_WARM_TTL_DAYS',
  'KICI_COLD_STORE_EXECUTION_RUNS_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_EXECUTION_RUNS_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_RUNS_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_RUNS_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_EXECUTION_RUNS_ENABLED',
  'KICI_COLD_STORE_EXECUTION_JOBS_WARM_TTL_DAYS',
  'KICI_COLD_STORE_EXECUTION_JOBS_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_EXECUTION_JOBS_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_JOBS_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_JOBS_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_EXECUTION_JOBS_ENABLED',
  'KICI_COLD_STORE_EXECUTION_STEPS_WARM_TTL_DAYS',
  'KICI_COLD_STORE_EXECUTION_STEPS_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_EXECUTION_STEPS_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_STEPS_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_EXECUTION_STEPS_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_EXECUTION_STEPS_ENABLED',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_WARM_TTL_DAYS',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_SECRET_AUDIT_LOG_ENABLED',
  'KICI_COLD_STORE_ACCESS_LOG_WARM_TTL_DAYS',
  'KICI_COLD_STORE_ACCESS_LOG_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_ACCESS_LOG_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_ACCESS_LOG_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_ACCESS_LOG_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_ACCESS_LOG_ENABLED',
  'KICI_COLD_STORE_EVENT_LOG_WARM_TTL_DAYS',
  'KICI_COLD_STORE_EVENT_LOG_MIN_WARM_TENANT_BYTES',
  'KICI_COLD_STORE_EVENT_LOG_MIN_CHUNK_BYTES',
  'KICI_COLD_STORE_EVENT_LOG_MAX_CHUNK_BYTES',
  'KICI_COLD_STORE_EVENT_LOG_MAX_ROWS_PER_CYCLE',
  'KICI_COLD_STORE_EVENT_LOG_ENABLED',
];

/**
 * Deployment-identity env vars injected by the installer (and the staging
 * deploy) so the orchestrator can report its own deployment shape in
 * `source.register`. Read directly from `process.env` by the deployment reader,
 * not threaded through the AppConfig schema — registered here so the
 * unknown-KICI_* validator at boot doesn't reject them.
 */
const DEPLOY_IDENTITY_ENV_VARS = [
  'KICI_DEPLOY_MODE',
  'KICI_DEPLOY_CONTAINER',
  'KICI_DEPLOY_CONTAINER_RUNTIME',
];

export function loadConfig(): AppConfig {
  const data = envDef.parse();

  // Reject typo'd KICI_* env vars at boot. Adds the logger's vars
  // (KICI_LOG_DIR, KICI_LOG_MAX_SIZE, …) and the cold-store overrides to the
  // known set so they don't trip the check.
  validateUnknownKiciVars([
    ...envDef.listKnownEnvVars(),
    ...LOGGER_ENV_VARS,
    ...COLD_STORE_ENV_VARS,
    ...DEPLOY_IDENTITY_ENV_VARS,
  ]);

  // Use cluster instanceId if provided, otherwise generate one
  const instanceId = data.cluster.instanceId || `${hostname()}-${randomUUID().slice(0, 8)}`;

  // Bridge KICI_STORAGE_* env vars into storage field. User-cache quota/TTL are
  // surfaced regardless of backend so the composition root can construct
  // UserCache even when no object-storage backend is configured.
  const userCacheStorage = {
    userCacheQuotaBytes: data.userCacheQuotaBytes,
    userCacheTtlMs: data.userCacheTtlMs,
  };
  let storage: AppConfig['storage'];
  if (data.cacheStorageType === 's3') {
    storage = {
      type: 's3',
      bucket: data.cacheStorageS3Bucket,
      prefix: data.cacheStorageS3Prefix,
      region: data.cacheStorageS3Region,
      endpoint: data.cacheStorageS3Endpoint,
      externalEndpoint: data.cacheStorageS3ExternalEndpoint,
      uploadEndpoint: data.cacheStorageS3UploadEndpoint,
      forcePathStyle: data.cacheStorageS3ForcePathStyle,
      logBucket: data.logStorageS3Bucket,
      ...userCacheStorage,
    };
  } else if (data.cacheStorageType === 'filesystem') {
    storage = {
      type: 'filesystem',
      fsBasePath: data.cacheStorageFsPath,
      fsBaseUrl: data.cacheStorageFsBaseUrl,
      ...userCacheStorage,
    };
  } else {
    storage = { ...userCacheStorage };
  }

  return {
    ...data,
    instanceId,
    storage,
  };
}
