import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Global KiCI configuration stored in ~/.kici/config.
 * Contains authentication tokens and endpoint settings.
 */
export interface GlobalConfig {
  /** API key for authentication (legacy) */
  token?: string;
  /** Orchestrator URL for direct mode */
  endpoint?: string;
  /** Platform relay URL */
  platformEndpoint?: string;
  /** OIDC issuer URL the PAT was minted against (provenance; from OAuth login) */
  oidcIssuer?: string;
  /** Routing key for webhook source identification (e.g., 'github:42') */
  routingKey?: string;
  /** Personal access token (from OAuth login) */
  pat?: string;
  /** PAT identifier (server-side ID) */
  patId?: string;
  /** PAT expiry timestamp (ISO 8601) */
  patExpiresAt?: string;
  /** Active organization ID */
  activeOrgId?: string;
  /** User email from OIDC token */
  userEmail?: string;
  /**
   * Per-org default orchestrator cluster for `kici run remote`, keyed by org id.
   * Set by `kici orchestrators use <cluster>`; consulted when `--orchestrator`
   * is omitted so a developer with one preferred cluster types no flag.
   */
  defaultClusters?: Record<string, string>;
}

/**
 * Strips unknown keys and validates known fields from a raw config object.
 * Returns a clean GlobalConfig with only recognized, valid fields.
 */
function sanitizeConfig(raw: unknown): GlobalConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }

  const obj = raw as Record<string, unknown>;
  const config: GlobalConfig = {};

  if (typeof obj.token === 'string') {
    config.token = obj.token;
  }
  if (typeof obj.endpoint === 'string') {
    config.endpoint = obj.endpoint;
  }
  if (typeof obj.platformEndpoint === 'string') {
    config.platformEndpoint = obj.platformEndpoint;
  }
  if (typeof obj.oidcIssuer === 'string') {
    config.oidcIssuer = obj.oidcIssuer;
  }
  if (typeof obj.routingKey === 'string') {
    config.routingKey = obj.routingKey;
  }
  if (typeof obj.pat === 'string') {
    config.pat = obj.pat;
  }
  if (typeof obj.patId === 'string') {
    config.patId = obj.patId;
  }
  if (typeof obj.patExpiresAt === 'string') {
    config.patExpiresAt = obj.patExpiresAt;
  }
  if (typeof obj.activeOrgId === 'string') {
    config.activeOrgId = obj.activeOrgId;
  }
  if (typeof obj.userEmail === 'string') {
    config.userEmail = obj.userEmail;
  }
  if (
    typeof obj.defaultClusters === 'object' &&
    obj.defaultClusters !== null &&
    !Array.isArray(obj.defaultClusters)
  ) {
    const clusters: Record<string, string> = {};
    for (const [orgId, clusterName] of Object.entries(obj.defaultClusters)) {
      if (typeof clusterName === 'string') {
        clusters[orgId] = clusterName;
      }
    }
    if (Object.keys(clusters).length > 0) {
      config.defaultClusters = clusters;
    }
  }

  return config;
}

/**
 * Returns the global KiCI config directory path.
 *
 * Resolution order:
 *   1. `KICI_CONFIG_DIR`, when set to a non-empty value.
 *   2. A hard refusal when `KICI_TEST_ISOLATION` is present. A developer
 *      machine's `~/.kici/config` names a real endpoint and carries a live
 *      PAT, so a test process that reads it authenticates against whatever
 *      that config points at — in practice, production. Every test that needs
 *      a config must name its own isolated directory.
 *   3. `~/.kici`.
 *
 * `KICI_TEST_ISOLATION` is set by this repository's own vitest configs, via
 * `hack/lib/vitest-isolation.ts`. It is deliberately a KiCI-owned name rather
 * than the runner's `VITEST`: `kici` is a compat-protected CLI, and `VITEST`
 * is a third-party marker that propagates into spawned children, so keying off
 * it would break a customer whose vitest test shells out to `kici`.
 *
 * `env` is injectable so this module's own tests can exercise every branch.
 * It is NOT an opt-out: production call sites pass no argument and inherit the
 * guard.
 */
export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KICI_CONFIG_DIR) {
    return env.KICI_CONFIG_DIR;
  }
  if (env.KICI_TEST_ISOLATION) {
    throw new Error(
      'Refusing to read the ambient ~/.kici config from a test process. ' +
        'Set KICI_CONFIG_DIR to an isolated directory for this run — ' +
        'the developer machine config may point at production.',
    );
  }
  return path.join(os.homedir(), '.kici');
}

/**
 * Returns the path to the global config file (~/.kici/config).
 */
export function getConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getConfigDir(env), 'config');
}

/**
 * Load the global KiCI config from ~/.kici/config.
 * Returns an empty object if the file does not exist.
 * Unknown keys are stripped; invalid values are ignored.
 */
export async function loadGlobalConfig(): Promise<GlobalConfig> {
  const configPath = getConfigPath();

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    return sanitizeConfig(parsed);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    if (err instanceof SyntaxError) {
      throw new Error(
        `Config file at ${configPath} contains invalid JSON. ` +
          'Delete it and re-run `kici login` to authenticate.',
      );
    }
    throw err;
  }
}

/**
 * Save the global KiCI config to ~/.kici/config.
 * Creates the config directory if needed.
 * Sets file permissions to 0o600 (owner read/write only) since it contains tokens.
 */
export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  const configDir = getConfigDir();
  await fs.mkdir(configDir, { recursive: true });

  const configPath = getConfigPath();
  const content = JSON.stringify(config, null, 2) + '\n';

  await fs.writeFile(configPath, content, { mode: 0o600 });
}

/**
 * Merge partial config into the existing global config.
 * Loads existing config, merges with the partial, saves, and returns the merged result.
 * Undefined values in the partial are ignored (existing values preserved).
 */
export async function mergeGlobalConfig(partial: Partial<GlobalConfig>): Promise<GlobalConfig> {
  const existing = await loadGlobalConfig();

  // Only merge defined values from partial
  const merged: GlobalConfig = { ...existing };
  if (partial.token !== undefined) merged.token = partial.token;
  if (partial.endpoint !== undefined) merged.endpoint = partial.endpoint;
  if (partial.platformEndpoint !== undefined) merged.platformEndpoint = partial.platformEndpoint;
  if (partial.routingKey !== undefined) merged.routingKey = partial.routingKey;
  if (partial.pat !== undefined) merged.pat = partial.pat;
  if (partial.patId !== undefined) merged.patId = partial.patId;
  if (partial.patExpiresAt !== undefined) merged.patExpiresAt = partial.patExpiresAt;
  if (partial.activeOrgId !== undefined) merged.activeOrgId = partial.activeOrgId;
  if (partial.userEmail !== undefined) merged.userEmail = partial.userEmail;
  if (partial.defaultClusters !== undefined) merged.defaultClusters = partial.defaultClusters;

  await saveGlobalConfig(merged);
  return merged;
}
