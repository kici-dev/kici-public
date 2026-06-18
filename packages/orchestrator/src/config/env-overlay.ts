/**
 * KICI_ environment variable to config path mapping and overlay.
 *
 * Converts KICI_-prefixed env vars to nested config paths and applies
 * them as overrides on top of a config object.
 *
 * Multi-app env var convention:
 * - App name in YAML: `main-org` -> env segment: `MAIN_ORG` (hyphen to underscore, uppercased)
 * - Example: KICI_PROVIDERS_GITHUB_MAIN_ORG_APP_ID -> providers.github[name=main-org].appId
 */

/**
 * Known direct env var mappings.
 * KICI_ prefix is stripped before lookup.
 * Keys are the remaining underscore-separated segments (uppercase).
 * Values are config path arrays.
 */
const DIRECT_MAPPINGS: Record<string, string[]> = {
  // Local config fields
  DATABASE_URL: ['database', 'url'],
  SERVER_PORT: ['server', 'port'],
  SERVER_BASE_PATH: ['server', 'basePath'],
  SERVER_LOG_LEVEL: ['server', 'logLevel'],
  SERVER_TLS_CERT_PATH: ['server', 'tlsCertPath'],
  INSTANCE_ID: ['instance', 'id'],
  INSTANCE_MODE: ['instance', 'mode'],
  SCALER_CONFIG_PATH: ['scaler', 'configPath'],
  SCALER_CONFIG_DIR: ['scaler', 'configDir'],

  // Shared config fields
  PLATFORM_URL: ['platform', 'url'],
  PLATFORM_TOKEN: ['platform', 'token'],
  AGENT_AUTH: ['agentAuth'],
  AGENT_TOKEN_TTL_MS: ['agentTokenTtlMs'],
  QUEUE_MAX_DEPTH: ['queue', 'maxDepth'],
  QUEUE_TIMEOUT_MS: ['queue', 'timeoutMs'],
  QUEUE_BACKPRESSURE_THRESHOLD: ['queue', 'backpressureThreshold'],
  LOCKFILE_CACHE_MAX: ['lockfileCache', 'max'],
  LOCKFILE_CACHE_TTL_MS: ['lockfileCache', 'ttlMs'],
  STALE_DETECTOR_SCAN_INTERVAL_MS: ['staleDetector', 'scanIntervalMs'],
  STALE_DETECTOR_THRESHOLD_MULTIPLIER: ['staleDetector', 'thresholdMultiplier'],
  JOB_HEARTBEAT_INTERVAL_MS: ['staleDetector', 'heartbeatIntervalMs'],
  SECRET_KEY: ['secrets', 'key'],
  SECRET_KEY_FILE: ['secrets', 'keyFile'],
  BOOTSTRAP_ADMIN_TOKEN: ['secrets', 'bootstrapAdminToken'],
  WEBHOOK_PAYLOAD_DIR: ['webhookPayloadDir'],
  CACHE_TTL_DAYS: ['cacheTtlDays'],
  CACHE_BUILD_TIMEOUT_MS: ['cacheBuildTimeoutMs'],
  CACHE_MAX_TARBALL_BYTES: ['cacheMaxTarballBytes'],
  USER_CACHE_QUOTA_BYTES: ['userCacheQuotaBytes'],
  USER_CACHE_TTL_MS: ['userCacheTtlMs'],

  // Storage env vars (KICI_STORAGE_*) are read directly by `defineEnv` /
  // `loadConfig` and bridged into `storage.*` there — no overlay entry
  // needed.

  // PG customer secrets toggle
  PG_CUSTOMER_SECRETS: ['pgCustomerSecrets'],

  // Event router
  EVENT_ROUTER_MAX_CHAIN_DEPTH: ['eventRouter', 'maxChainDepth'],
  EVENT_ROUTER_RATE_LIMIT_PER_WORKFLOW_PER_MINUTE: ['eventRouter', 'rateLimitPerWorkflowPerMinute'],
  EVENT_ROUTER_EVENT_TTL_SECONDS: ['eventRouter', 'eventTtlSeconds'],
  EVENT_ROUTER_CLEANUP_INTERVAL_MS: ['eventRouter', 'cleanupIntervalMs'],

  // Inbound webhook delivery log
  EVENT_LOG_MAX_PAYLOAD_BYTES: ['eventLog', 'maxPayloadBytes'],

  // Cluster
  CLUSTER_JOIN_TOKEN: ['cluster', 'joinToken'],
  CLUSTER_CREDENTIAL_FILE: ['cluster', 'credentialFile'],
  CLUSTER_AUTO_ROTATE_CREDENTIALS: ['cluster', 'autoRotateCredentials'],
  CLUSTER_ADDRESS: ['cluster', 'address'],
  CLUSTER_INSTANCE_ID: ['cluster', 'instanceId'],
  CLUSTER_PEERS: ['cluster', 'peers'],
  CLUSTER_RAFT_ELECTION_TIMEOUT_MIN_MS: ['cluster', 'raftElectionTimeoutMinMs'],
  CLUSTER_RAFT_ELECTION_TIMEOUT_MAX_MS: ['cluster', 'raftElectionTimeoutMaxMs'],
  CLUSTER_RAFT_HEARTBEAT_MS: ['cluster', 'raftHeartbeatMs'],
  CLUSTER_PEER_HEARTBEAT_INTERVAL_MS: ['cluster', 'peerHeartbeatIntervalMs'],
  CLUSTER_PEER_MAX_RECONNECT_DELAY_MS: ['cluster', 'peerMaxReconnectDelayMs'],
  CLUSTER_ROLE: ['cluster', 'role'],
  CLUSTER_COORDINATOR_URL: ['cluster', 'coordinatorUrl'],
  CLUSTER_PEER_STALE_TIMEOUT_MS: ['cluster', 'peerStaleTimeoutMs'],

  // Logging/environment
  LOG_LEVEL: ['logLevel'],
  NODE_ENV: ['nodeEnv'],
};

/**
 * Legacy unprefixed env vars honored by the startup `loadConfig()` path
 * (see `config.ts`). These are mapped into the same config shape used by
 * the config reloader so that env-var-only deployments (no YAML file) can
 * successfully reload without tripping schema validation.
 *
 * KICI_-prefixed equivalents (above) take precedence over these when both
 * are set, matching startup behavior where KICI_ env vars are the newer
 * canonical form.
 *
 * Only `NODE_ENV` is honored unprefixed — it is an OS-level convention
 * that pre-dates KiCI, owned by the Node.js ecosystem rather than by us.
 * Every other operational env var is `KICI_*` only; the rest of the
 * legacy table was removed during the env-var standardization rollout.
 */
const LEGACY_MAPPINGS: Record<string, string[]> = {
  NODE_ENV: ['nodeEnv'],
};

/**
 * Known GitHub app field name suffixes (uppercase env -> camelCase config).
 */
const GITHUB_APP_FIELDS: Record<string, string> = {
  APP_ID: 'appId',
  PRIVATE_KEY: 'privateKey',
  WEBHOOK_SECRET: 'webhookSecret',
};

/**
 * Fields that should be coerced to numbers.
 */
const NUMERIC_FIELDS = new Set([
  'server.port',
  'agentTokenTtlMs',
  'queue.maxDepth',
  'queue.timeoutMs',
  'queue.backpressureThreshold',
  'lockfileCache.max',
  'lockfileCache.ttlMs',
  'staleDetector.scanIntervalMs',
  'staleDetector.thresholdMultiplier',
  'staleDetector.heartbeatIntervalMs',
  'cacheTtlDays',
  'cacheBuildTimeoutMs',
  'cacheMaxTarballBytes',
  'userCacheQuotaBytes',
  'userCacheTtlMs',
  'cluster.raftElectionTimeoutMinMs',
  'cluster.raftElectionTimeoutMaxMs',
  'cluster.raftHeartbeatMs',
  'cluster.peerHeartbeatIntervalMs',
  'cluster.peerMaxReconnectDelayMs',
  'cluster.peerStaleTimeoutMs',
  'eventRouter.maxChainDepth',
  'eventRouter.rateLimitPerWorkflowPerMinute',
  'eventRouter.eventTtlSeconds',
  'eventRouter.cleanupIntervalMs',
  'eventLog.maxPayloadBytes',
]);

/**
 * Fields that should be coerced to booleans.
 */
const BOOLEAN_FIELDS = new Set(['cluster.autoRotateCredentials', 'pgCustomerSecrets']);

/**
 * Convert a KICI_ env var key to a config path array.
 * Returns null for non-KICI_ keys or unknown mappings.
 *
 * Handles two patterns:
 * 1. Direct mappings (KICI_DATABASE_URL -> ['database', 'url'])
 * 2. Multi-app GitHub provider (KICI_PROVIDERS_GITHUB_<NAME>_<FIELD> ->
 *    ['providers', 'github', '<name-lowered>', '<camelField>'])
 */
export function envKeyToConfigPath(key: string): string[] | null {
  // Legacy unprefixed env vars (NODE_ENV) used by the startup
  // loader — honored here so env-only deployments can reload.
  if (LEGACY_MAPPINGS[key]) {
    return LEGACY_MAPPINGS[key];
  }

  if (!key.startsWith('KICI_')) return null;

  const remainder = key.slice(5); // strip KICI_

  // Check direct mappings first
  if (DIRECT_MAPPINGS[remainder]) {
    return DIRECT_MAPPINGS[remainder];
  }

  // Check multi-app GitHub provider pattern: PROVIDERS_GITHUB_<NAME>_<FIELD>
  if (remainder.startsWith('PROVIDERS_GITHUB_')) {
    const afterGithub = remainder.slice(17); // strip PROVIDERS_GITHUB_

    // Try each known field suffix (longest first to avoid partial matches)
    const sortedFields = Object.entries(GITHUB_APP_FIELDS).sort(
      (a, b) => b[0].length - a[0].length,
    );

    for (const [envSuffix, configField] of sortedFields) {
      if (afterGithub.endsWith(`_${envSuffix}`)) {
        // Extract the app name: everything between PROVIDERS_GITHUB_ and _FIELD
        const appNameUpper = afterGithub.slice(0, -(envSuffix.length + 1));
        if (appNameUpper.length === 0) continue;

        // Convert UPPER_CASE env name to lower-case-hyphenated config name
        const appName = appNameUpper.toLowerCase().replace(/_/g, '-');
        return ['providers', 'github', appName, configField];
      }
    }
  }

  return null;
}

/**
 * Coerce a string env var value to the appropriate type for its config path.
 */
function coerceValue(path: string[], value: string): unknown {
  const pathStr = path.join('.');

  if (NUMERIC_FIELDS.has(pathStr)) {
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
  }

  if (BOOLEAN_FIELDS.has(pathStr)) {
    return value === 'true';
  }

  return value;
}

/**
 * Apply KICI_ env var overrides onto a config object.
 * Iterates all env vars, maps KICI_ ones to paths, and deep-sets values.
 *
 * @param config - Base config object (cloned, not mutated)
 * @param env - Process environment
 * @returns New config object with env overrides applied
 */
export function applyEnvOverrides(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const result = structuredClone(config);

  // Apply legacy unprefixed env vars first (NODE_ENV), then KICI_-prefixed
  // vars on top, so the newer canonical KICI_* names deterministically
  // override legacy vars when both are set.
  const legacyEntries: Array<[string, string]> = [];
  const kiciEntries: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (LEGACY_MAPPINGS[key]) {
      legacyEntries.push([key, value]);
    } else if (key.startsWith('KICI_')) {
      kiciEntries.push([key, value]);
    }
  }

  for (const [key, value] of [...legacyEntries, ...kiciEntries]) {
    const path = envKeyToConfigPath(key);
    if (!path) continue;

    const coerced = coerceValue(path, value);
    deepSetByPath(result, path, coerced);
  }

  return result;
}

/**
 * Deep merge two objects. Objects merge recursively, arrays replace,
 * undefined/null values in source do NOT override target.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(target);

  for (const [key, sourceVal] of Object.entries(source)) {
    // Skip undefined/null source values -- they don't override
    if (sourceVal === undefined || sourceVal === null) continue;

    const targetVal = result[key];

    // If both are plain objects (not arrays), merge recursively
    if (
      isPlainObject(targetVal) &&
      isPlainObject(sourceVal) &&
      !Array.isArray(targetVal) &&
      !Array.isArray(sourceVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      // Arrays replace, primitives replace
      result[key] = structuredClone(sourceVal);
    }
  }

  return result;
}

/**
 * Set a value at a nested path in an object.
 * Creates intermediate objects as needed.
 */
export function deepSetByPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    if (
      current[segment] === null ||
      current[segment] === undefined ||
      typeof current[segment] !== 'object'
    ) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  current[path[path.length - 1]] = value;
}

/**
 * Get a value at a nested path in an object.
 * Returns undefined if path doesn't exist.
 */
export function deepGetByPath(obj: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = obj;

  for (const segment of path) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Check if a value is a plain object (not array, not null).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
