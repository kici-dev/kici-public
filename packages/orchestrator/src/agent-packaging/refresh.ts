/**
 * Auto-refresh of version-keyed agent payloads on `orchestrator upgrade`
 * (auto-deploy ⟹ auto-upgrade ⟹ auto-package).
 *
 * After an upgrade to version V, produces + uploads
 * `agent-packages/V/kici-agent-<platform>.tar.gz(.sha256)` for the fleet's platforms, so the
 * convergence gate finds its bytes with no operator step. Idempotent: an existing payload for V
 * is skipped.
 */
import { AgentPlatform } from '@kici-dev/shared';
import { assertPayloadsAvailable } from './availability.js';
import { agentPackageExists, type AgentPackageDownloadStorage } from './download.js';
import { AGENT_PACKAGES_PREFIX, parseAgentPackageKey, uploadAgentPackage } from './upload.js';

/** Storage surface the refresh needs: existence check, listing, put. */
export interface RefreshStorage extends AgentPackageDownloadStorage {
  put(key: string, data: Buffer | string): Promise<void>;
  list(subPrefix: string): Promise<string[]>;
}

/** Result of one produced payload, as `kici-admin agent package` yields it. */
export interface BuiltPayload {
  tarballPath: string;
  sha256: string;
}

export interface RefreshDeps {
  /** Build one platform's self-contained payload for `version` (the packaging lib). */
  build: (platform: AgentPlatform, version: string) => Promise<BuiltPayload>;
  /** Optional log sink (defaults to no-op); the CLI wires console.log. */
  log?: (msg: string) => void;
}

export interface RefreshResult {
  produced: AgentPlatform[];
  skipped: AgentPlatform[];
}

/**
 * The platforms the fleet has payloads for: the union across every stored version EXCEPT
 * `excludeVersion` (the target about to be (re)produced), preserving arch coverage across an
 * upgrade. Empty ⇒ the caller falls back to the bootstrap default set.
 */
export async function discoverFleetPlatforms(
  storage: RefreshStorage,
  excludeVersion: string,
): Promise<AgentPlatform[]> {
  const keys = await storage.list(AGENT_PACKAGES_PREFIX);
  const platforms = new Set<AgentPlatform>();
  for (const key of keys) {
    // `list` returns keys relative to the storage prefix; re-anchor onto the
    // `agent-packages/` sub-prefix so the parser sees a full payload key.
    const full = key.startsWith(AGENT_PACKAGES_PREFIX) ? key : `${AGENT_PACKAGES_PREFIX}${key}`;
    const parsed = parseAgentPackageKey(full);
    if (parsed && parsed.version !== excludeVersion) platforms.add(parsed.platform);
  }
  return [...platforms];
}

/**
 * Produce + upload the target version's missing payloads. Explicit `platforms` override
 * discovery; otherwise the fleet's arch coverage is kept, or the bootstrap default
 * (`AgentPlatform.options`) on a fresh store.
 */
export async function refreshAgentPackages(
  storage: RefreshStorage,
  version: string,
  opts: { platforms?: AgentPlatform[] },
  deps: RefreshDeps,
): Promise<RefreshResult> {
  const log = deps.log ?? (() => {});
  let platforms = opts.platforms;
  if (!platforms || platforms.length === 0) {
    const discovered = await discoverFleetPlatforms(storage, version);
    platforms = discovered.length > 0 ? discovered : [...AgentPlatform.options];
  }

  const produced: AgentPlatform[] = [];
  const skipped: AgentPlatform[] = [];
  for (const platform of platforms) {
    if (await agentPackageExists(storage, version, platform)) {
      log(`[agent package refresh] ${platform} @ ${version} already present — skip`);
      skipped.push(platform);
      continue;
    }
    log(`[agent package refresh] producing ${platform} @ ${version}`);
    const built = await deps.build(platform, version);
    const { key } = await uploadAgentPackage(
      storage,
      version,
      platform,
      built.tarballPath,
      built.sha256,
    );
    log(`[agent package refresh] uploaded ${key}`);
    produced.push(platform);
  }

  // A partial produce/upload fails loudly instead of leaving a platform without bytes.
  const { available, missing } = await assertPayloadsAvailable(storage, version, platforms);
  if (!available) {
    throw new Error(
      `agent-package refresh incomplete for ${version}: missing ${missing.join(', ')}`,
    );
  }
  return { produced, skipped };
}
