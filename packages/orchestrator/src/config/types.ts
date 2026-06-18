/**
 * Configuration type system for the orchestrator.
 *
 * Three-layer config model:
 * - LocalConfig: per-orchestrator settings from YAML file
 * - SharedConfig: shared settings stored in PostgreSQL config_versions table
 * - AppConfig: merged result type used throughout the codebase
 */

/**
 * Per-orchestrator settings loaded from YAML file.
 * These are instance-specific and never shared across orchestrators.
 */
export interface LocalConfig {
  database: {
    url: string;
  };
  instance?: {
    id?: string;
    mode?: 'platform' | 'hybrid' | 'independent';
  };
  server?: {
    port?: number;
    basePath?: string;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    tlsCertPath?: string;
  };
  scaler?: {
    configPath?: string;
    configDir?: string;
  };
}

/**
 * Shared configuration stored in PostgreSQL config_versions table.
 * Defined once, shared across all orchestrator instances.
 */
export interface SharedConfig {
  platform?: {
    url?: string;
    token?: string;
  };
  storage?: {
    type?: 's3';
    bucket?: string;
    prefix?: string;
    region?: string;
    endpoint?: string;
    externalEndpoint?: string;
    forcePathStyle?: boolean;
    logBucket?: string;
  };
  agentAuth?: 'token' | 'none';
  agentTokenTtlMs?: number;
  rosterGraceMs?: number;
  rosterTtlMs?: number;
  maxFanoutHosts?: number;
  queue?: {
    maxDepth?: number;
    timeoutMs?: number;
    /**
     * Pending-depth threshold that triggers the operator-facing backpressure
     * warning. `0` disables the warner (metrics still exported).
     */
    backpressureThreshold?: number;
  };
  lockfileCache?: {
    max?: number;
    ttlMs?: number;
  };
  staleDetector?: {
    scanIntervalMs?: number;
    thresholdMultiplier?: number;
    heartbeatIntervalMs?: number;
  };
  secrets?: {
    key?: string;
    keyFile?: string;
    bootstrapAdminToken?: string;
  };
  pgCustomerSecrets?: boolean;
  cluster?: {
    joinToken?: string;
    raftElectionTimeoutMinMs?: number;
    raftElectionTimeoutMaxMs?: number;
    raftHeartbeatMs?: number;
    peerHeartbeatIntervalMs?: number;
    peerMaxReconnectDelayMs?: number;
  };
  webhookPayloadDir?: string;
  cacheTtlDays?: number;
  cacheBuildTimeoutMs?: number;
  cacheMaxTarballBytes?: number;
  eventRouter?: {
    maxChainDepth?: number;
    rateLimitPerWorkflowPerMinute?: number;
    eventTtlSeconds?: number;
    cleanupIntervalMs?: number;
  };
  eventLog?: {
    maxPayloadBytes?: number;
  };
}

/**
 * Merged application configuration used throughout the codebase.
 * Combines LocalConfig + SharedConfig with resolved defaults.
 */
export interface AppConfig {
  /** Unique identifier for this orchestrator instance */
  instanceId: string;
  /** Operating mode */
  mode: 'platform' | 'hybrid' | 'independent';

  // --- From LocalConfig ---
  /** PostgreSQL connection URL */
  databaseUrl: string;
  /** HTTP server port */
  port: number;
  /** HTTP base path */
  basePath: string;
  /** Path to TLS certificate (PEM) for expiry diagnostic check. Optional. */
  tlsCertPath?: string;
  /** Scaler YAML config file path */
  scalerConfigPath?: string;
  /** Scaler scalers.d/ directory path */
  scalerConfigDir?: string;

  // --- From SharedConfig ---
  /** Platform relay connection settings */
  platformUrl?: string;
  platformToken?: string;
  /** Object storage settings */
  storage?: {
    type?: 's3';
    bucket?: string;
    prefix?: string;
    region?: string;
    endpoint?: string;
    externalEndpoint?: string;
    forcePathStyle?: boolean;
    logBucket?: string;
  };
  /** Agent authentication mode */
  agentAuth: 'token' | 'none';
  /** Agent token TTL in milliseconds */
  agentTokenTtlMs: number;
  /** Host roster: static grace before a disconnected static host reads unreachable (ms) */
  rosterGraceMs: number;
  /** Host roster: ephemeral GC ttl — past this a disconnected ephemeral host is reaped (ms) */
  rosterTtlMs: number;
  /** Cap on per-host children produced by a runsOnAll fan-out */
  maxFanoutHosts: number;
  /** Queue settings */
  queueMaxDepth: number;
  queueTimeoutMs: number;
  /**
   * Pending-depth threshold for operator backpressure warnings. When the
   * pending dispatch_queue depth stays at or above this for two consecutive
   * refresher ticks (~10s), a structured `logger.warn` is emitted. `0`
   * disables the warner entirely (metrics still exported). Default: 100.
   */
  queueBackpressureThreshold: number;
  /** Lockfile cache settings */
  lockfileCacheMax: number;
  lockfileCacheTtlMs: number;
  /** Stale detector settings */
  staleDetectorScanIntervalMs: number;
  staleDetectorThresholdMultiplier: number;
  jobHeartbeatIntervalMs: number;
  /** Secrets management */
  secretKey?: string;
  secretKeyFile?: string;
  bootstrapAdminToken?: string;
  /** Allow dashboard users to create PG-stored secrets */
  pgCustomerSecrets: boolean;
  /** Cluster settings */
  cluster: {
    instanceId: string;
    address?: string;
    joinToken?: string;
    credentialFile: string;
    autoRotateCredentials: boolean;
    peers: string[];
    raftElectionTimeoutMinMs: number;
    raftElectionTimeoutMaxMs: number;
    raftHeartbeatMs: number;
    peerHeartbeatIntervalMs: number;
    peerMaxReconnectDelayMs: number;
    /** Cluster role: coordinator (full orchestrator) or worker (delegated execution). */
    role: 'coordinator' | 'worker';
    /** URL of the coordinator to connect to when role=worker. */
    coordinatorUrl?: string;
    /** Stale peer timeout in ms. */
    peerStaleTimeoutMs: number;
  };
  /** Webhook payload storage directory */
  webhookPayloadDir?: string;
  /** Cache TTL in days */
  cacheTtlDays: number;
  /** Cache build timeout in ms */
  cacheBuildTimeoutMs: number;
  /** Max dependency tarball size in bytes */
  cacheMaxTarballBytes: number;
  /** Event router: max chain depth before circuit breaker trips */
  eventRouterMaxChainDepth: number;
  /** Event router: max events per event name per minute */
  eventRouterRateLimitPerWorkflowPerMinute: number;
  /** Event router: event TTL in seconds */
  eventRouterEventTtlSeconds: number;
  /** Event router: cleanup interval in milliseconds */
  eventRouterCleanupIntervalMs: number;
  /** Inbound webhook delivery log: soft cap (bytes). Oversized deliveries are
   *  recorded with payload_omitted=true rather than 413'd. */
  eventLogMaxPayloadBytes: number;
  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Node environment */
  nodeEnv: 'development' | 'production' | 'test';
}

/**
 * Database row type for the config_versions table.
 * Each row is an immutable snapshot of the shared configuration.
 */
export interface ConfigVersion {
  id: string;
  version: number;
  config: Record<string, unknown>;
  createdAt: Date;
  createdBy: string;
  description: string | null;
  encryptedPaths: string[];
}
