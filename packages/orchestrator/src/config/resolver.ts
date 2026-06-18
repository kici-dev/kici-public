/**
 * Config resolution chain.
 *
 * Two-phase design:
 * - Phase 1: resolveLocalConfig() -- env + YAML only, returns database URL,
 *   instance ID, server port (needed before DB is available)
 * - Phase 2: resolveFullConfig() -- merges defaults -> DB -> YAML -> env,
 *   validates with appConfigSchema, returns typed AppConfig
 *
 * Precedence: env var > local YAML > shared DB > defaults
 */

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadLocalConfig } from './loader.js';
import { appConfigSchema } from './schema.js';
import { applyEnvOverrides, deepMerge } from './env-overlay.js';
import type { AppConfig, SharedConfig } from './types.js';

/**
 * Phase 1 result: minimal config resolved from local sources only.
 */
export interface LocalPhaseResult {
  /** The raw local config (from YAML + env overlay) */
  local: Record<string, unknown>;
  /** Resolved database URL */
  databaseUrl: string;
  /** Resolved instance ID */
  instanceId: string;
  /** Resolved server port */
  port: number;
  /** Resolved instance mode */
  mode: 'platform' | 'hybrid' | 'independent';
}

/**
 * Phase 1: Resolve local-only config.
 * Loads YAML, applies env overrides for local fields.
 * Returns database URL and instance ID (needed before DB init).
 */
export async function resolveLocalConfig(configPath?: string): Promise<LocalPhaseResult> {
  // Load YAML (may return empty config for env-only mode)
  const yamlConfig = await loadLocalConfig(configPath);

  // Apply env overrides on top of YAML
  const localWithEnv = applyEnvOverrides(
    yamlConfig as unknown as Record<string, unknown>,
    process.env,
  );

  // Extract local-only fields
  const db = localWithEnv.database as Record<string, unknown> | undefined;
  const databaseUrl = (db?.url as string) || '';

  const instance = localWithEnv.instance as Record<string, unknown> | undefined;
  const instanceId = (instance?.id as string) || `${hostname()}-${randomUUID().slice(0, 8)}`;
  const mode = ((instance?.mode as string) || 'platform') as 'platform' | 'hybrid' | 'independent';

  const server = localWithEnv.server as Record<string, unknown> | undefined;
  const port = (server?.port as number) || 4000;

  return {
    local: localWithEnv,
    databaseUrl,
    instanceId,
    port,
    mode,
  };
}

/**
 * Phase 2: Resolve full config by merging all 4 layers.
 * Precedence: env var > local YAML > shared DB > defaults.
 *
 * @param localConfig - Raw local config object (from Phase 1 or YAML parse)
 * @param dbConfig - Shared config from DB (null if no DB config exists)
 * @param env - Environment variables (defaults to process.env)
 */
export function resolveFullConfig(
  localConfig: Record<string, unknown>,
  dbConfig: SharedConfig | null,
  env?: NodeJS.ProcessEnv,
): AppConfig {
  const effectiveEnv = env ?? process.env;

  // Layer 1: Start with defaults
  const defaults = getDefaults();
  let merged: Record<string, unknown> = defaults as Record<string, unknown>;

  // Layer 2: Merge DB config on top of defaults
  if (dbConfig) {
    merged = deepMerge(merged, dbConfig as unknown as Record<string, unknown>);
  }

  // Layer 3: Merge local YAML on top
  merged = deepMerge(merged, localConfig);

  // Layer 4: Apply env overrides (highest precedence)
  merged = applyEnvOverrides(merged, effectiveEnv);

  // Flatten to AppConfig shape
  const flat = flattenToAppConfig(merged);

  // Validate with appConfigSchema
  const result = appConfigSchema.safeParse(flat);

  if (!result.success) {
    const errors = result.error.issues
      .map((e) => `  - ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  return result.data as unknown as AppConfig;
}

/**
 * Get default values for shared config fields.
 */
export function getDefaults(): Partial<SharedConfig> {
  return {
    agentAuth: 'token',
    agentTokenTtlMs: 3_600_000,
    rosterGraceMs: 300_000,
    rosterTtlMs: 1_800_000,
    maxFanoutHosts: 1024,
    queue: {
      maxDepth: 1000,
      timeoutMs: 3_600_000,
      backpressureThreshold: 100,
    },
    lockfileCache: {
      max: 500,
      ttlMs: 3_600_000,
    },
    staleDetector: {
      scanIntervalMs: 60_000,
      thresholdMultiplier: 2,
      heartbeatIntervalMs: 60_000,
    },
    cacheTtlDays: 30,
    cacheBuildTimeoutMs: 600_000,
    cacheMaxTarballBytes: 524_288_000,
    eventRouter: {
      maxChainDepth: 10,
      rateLimitPerWorkflowPerMinute: 100,
      eventTtlSeconds: 604_800,
      cleanupIntervalMs: 3_600_000,
    },
    eventLog: {
      maxPayloadBytes: 5 * 1024 * 1024,
    },
  };
}

/**
 * Flatten the merged config tree into the flat AppConfig shape.
 * Maps nested structures to flat field names for backward compatibility.
 */
function flattenToAppConfig(merged: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = {};

  // Database
  const db = merged.database as Record<string, unknown> | undefined;
  flat.databaseUrl = db?.url ?? '';

  // Instance
  const instance = merged.instance as Record<string, unknown> | undefined;
  flat.instanceId = instance?.id || `${hostname()}-${randomUUID().slice(0, 8)}`;
  flat.mode = instance?.mode ?? 'platform';

  // Server
  const server = merged.server as Record<string, unknown> | undefined;
  flat.port = server?.port ?? 4000;
  flat.basePath = server?.basePath ?? '/';
  if (server?.tlsCertPath) flat.tlsCertPath = server.tlsCertPath;

  // Scaler
  const scaler = merged.scaler as Record<string, unknown> | undefined;
  if (scaler?.configPath) flat.scalerConfigPath = scaler.configPath;
  if (scaler?.configDir) flat.scalerConfigDir = scaler.configDir;

  // Platform
  const platform = merged.platform as Record<string, unknown> | undefined;
  if (platform?.url) flat.platformUrl = platform.url;
  if (platform?.token) flat.platformToken = platform.token;

  // Storage (pass through)
  if (merged.storage) flat.storage = merged.storage;

  // Agent auth
  flat.agentAuth = merged.agentAuth ?? 'token';
  flat.agentTokenTtlMs = merged.agentTokenTtlMs ?? 3_600_000;
  flat.rosterGraceMs = merged.rosterGraceMs ?? 300_000;
  flat.rosterTtlMs = merged.rosterTtlMs ?? 1_800_000;
  flat.maxFanoutHosts = merged.maxFanoutHosts ?? 1024;

  // Queue
  const queue = merged.queue as Record<string, unknown> | undefined;
  flat.queueMaxDepth = queue?.maxDepth ?? 1000;
  flat.queueTimeoutMs = queue?.timeoutMs ?? 3_600_000;
  flat.queueBackpressureThreshold = queue?.backpressureThreshold ?? 100;

  // Lockfile cache
  const lfCache = merged.lockfileCache as Record<string, unknown> | undefined;
  flat.lockfileCacheMax = lfCache?.max ?? 500;
  flat.lockfileCacheTtlMs = lfCache?.ttlMs ?? 3_600_000;

  // Stale detector
  const stale = merged.staleDetector as Record<string, unknown> | undefined;
  flat.staleDetectorScanIntervalMs = stale?.scanIntervalMs ?? 60_000;
  flat.staleDetectorThresholdMultiplier = stale?.thresholdMultiplier ?? 2;
  flat.jobHeartbeatIntervalMs = stale?.heartbeatIntervalMs ?? 60_000;

  // Secrets
  const secrets = merged.secrets as Record<string, unknown> | undefined;
  if (secrets?.key) flat.secretKey = secrets.key;
  if (secrets?.keyFile) flat.secretKeyFile = secrets.keyFile;
  if (secrets?.bootstrapAdminToken) flat.bootstrapAdminToken = secrets.bootstrapAdminToken;

  // PG customer secrets toggle
  if (merged.pgCustomerSecrets !== undefined) {
    flat.pgCustomerSecrets = merged.pgCustomerSecrets;
  }

  // Cluster
  const cluster = merged.cluster as Record<string, unknown> | undefined;
  flat.cluster = {
    instanceId: cluster?.instanceId ?? randomUUID(),
    address: cluster?.address,
    joinToken: cluster?.joinToken as string | undefined,
    credentialFile: (cluster?.credentialFile as string) ?? '~/.kici/peer-credential',
    autoRotateCredentials: (cluster?.autoRotateCredentials as boolean) ?? false,
    peers: cluster?.peers ?? [],
    raftElectionTimeoutMinMs: cluster?.raftElectionTimeoutMinMs ?? 5000,
    raftElectionTimeoutMaxMs: cluster?.raftElectionTimeoutMaxMs ?? 10000,
    raftHeartbeatMs: cluster?.raftHeartbeatMs ?? 2000,
    peerHeartbeatIntervalMs: cluster?.peerHeartbeatIntervalMs ?? 30000,
    peerMaxReconnectDelayMs: cluster?.peerMaxReconnectDelayMs ?? 60000,
    role: cluster?.role ?? 'coordinator',
    coordinatorUrl: cluster?.coordinatorUrl as string | undefined,
    peerStaleTimeoutMs: cluster?.peerStaleTimeoutMs ?? 60_000,
  };

  // Misc
  if (merged.webhookPayloadDir) flat.webhookPayloadDir = merged.webhookPayloadDir;
  flat.cacheTtlDays = merged.cacheTtlDays ?? 30;
  flat.cacheBuildTimeoutMs = merged.cacheBuildTimeoutMs ?? 600_000;
  flat.cacheMaxTarballBytes = merged.cacheMaxTarballBytes ?? 524_288_000;

  // Event router
  const eventRouter = merged.eventRouter as Record<string, unknown> | undefined;
  flat.eventRouterMaxChainDepth = eventRouter?.maxChainDepth ?? 10;
  flat.eventRouterRateLimitPerWorkflowPerMinute = eventRouter?.rateLimitPerWorkflowPerMinute ?? 100;
  flat.eventRouterEventTtlSeconds = eventRouter?.eventTtlSeconds ?? 604_800;
  flat.eventRouterCleanupIntervalMs = eventRouter?.cleanupIntervalMs ?? 3_600_000;

  // Event log (inbound webhook delivery log)
  const eventLog = merged.eventLog as Record<string, unknown> | undefined;
  flat.eventLogMaxPayloadBytes = eventLog?.maxPayloadBytes ?? 5 * 1024 * 1024;

  // Logging
  const logLevel = merged.logLevel ?? (server as Record<string, unknown>)?.logLevel ?? 'info';
  flat.logLevel = logLevel;
  flat.nodeEnv = merged.nodeEnv ?? 'development';

  return flat;
}
