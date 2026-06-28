/**
 * Startup guard: an orchestrator that runs non-co-located agents (any scaler
 * backend) must not hand them a loopback storage URL. Loopback is only
 * reachable by a co-located process, so a scaled agent would fail with an
 * opaque ECONNREFUSED. This module detects the misconfiguration so the
 * orchestrator can refuse to start with a clear, actionable error.
 */
import { ScalerBackendType } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import type { AppConfig } from '../config.js';
import type { ScalerConfig } from '../scaler/types.js';

const logger = createLogger({ prefix: 'storage' });

/**
 * Every current scaler backend places the agent outside the orchestrator's
 * loopback (separate netns, microVM, or host). Only a future co-located/"local"
 * backend would be absent from this set. `kubernetes` is included defensively
 * even though `ScalerEntry.type` excludes it today.
 */
export const NON_COLOCATED_BACKENDS: ReadonlySet<ScalerBackendType> = new Set([
  ScalerBackendType.enum.container,
  ScalerBackendType.enum['bare-metal'],
  ScalerBackendType.enum.firecracker,
  ScalerBackendType.enum.kubernetes,
]);

/** True for any host an agent in another netns/VM/host cannot reach. */
export function isLoopbackHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost') return true;
  if (h === '::1' || h === '::') return true;
  if (h === '0.0.0.0') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const octets = m.slice(1).map(Number);
    if (octets.every((o) => o <= 255) && octets[0] === 127) return true;
  }
  return false;
}

/** Extract the host from a URL string; null when it cannot be parsed. */
function parseHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Decide whether an agent-facing storage URL is a loopback address that a
 * non-co-located agent could not reach. Returns a remediation message, or null
 * when the configuration is safe.
 */
export function checkLoopbackAgentEndpoint(input: {
  agentFacingUrl: string | null;
  endpointSource: string;
  fixEnvVar: string;
  scalerBackends: ScalerBackendType[];
}): { message: string } | null {
  const { agentFacingUrl, endpointSource, fixEnvVar, scalerBackends } = input;
  if (!agentFacingUrl) return null;

  const nonColocated = scalerBackends.filter((b) => NON_COLOCATED_BACKENDS.has(b));
  if (nonColocated.length === 0) return null;

  const host = parseHost(agentFacingUrl);
  if (!host || !isLoopbackHost(host)) return null;

  const backends = [...new Set(nonColocated)].join(', ');
  return {
    message:
      `Storage misconfiguration: the agent-facing storage endpoint resolves to a ` +
      `loopback address (${agentFacingUrl}, from ${endpointSource}), but this ` +
      `orchestrator runs non-co-located agents (scaler backends: ${backends}). A ` +
      `loopback URL is only reachable by a co-located process; a scaled agent will ` +
      `fail with ECONNREFUSED. Set ${fixEnvVar} to an address reachable from the ` +
      `agents (e.g. the host's LAN/DNS name) and restart.`,
  };
}

/**
 * Resolve the URL an AGENT would use to reach storage, plus the env var an
 * operator would set to fix a loopback misconfiguration. Returns null when the
 * storage backend has no agent-facing URL to validate.
 */
export function resolveAgentFacingStorage(
  config: AppConfig,
): { url: string | null; source: string; fixEnvVar: string } | null {
  const storage = config.storage;
  if (!storage) return null;

  if (storage.type === 's3') {
    const url = storage.externalEndpoint ?? storage.endpoint ?? null;
    const source = storage.externalEndpoint
      ? 'KICI_STORAGE_EXTERNAL_ENDPOINT'
      : 'KICI_STORAGE_ENDPOINT';
    return { url, source, fixEnvVar: 'KICI_STORAGE_EXTERNAL_ENDPOINT' };
  }

  if (storage.type === 'filesystem') {
    const url = storage.fsBaseUrl ?? `http://127.0.0.1:${config.port}`;
    const source = storage.fsBaseUrl ? 'KICI_STORAGE_FS_BASE_URL' : '(default 127.0.0.1)';
    return { url, source, fixEnvVar: 'KICI_STORAGE_FS_BASE_URL' };
  }

  return null;
}

/**
 * Refuse to start when this orchestrator runs non-co-located agents (any scaler
 * configured) and the agent-facing storage URL is a loopback address. Logs the
 * remediation (so it reaches `kici-admin orchestrator logs`) then throws.
 */
export function assertAgentReachableStorage(
  config: AppConfig,
  scalerConfig: ScalerConfig | null,
): void {
  if (!scalerConfig || scalerConfig.scalers.length === 0) return;

  const resolved = resolveAgentFacingStorage(config);
  if (!resolved) return;

  const scalerBackends = scalerConfig.scalers.map((s) => s.type);
  const drift = checkLoopbackAgentEndpoint({
    agentFacingUrl: resolved.url,
    endpointSource: resolved.source,
    fixEnvVar: resolved.fixEnvVar,
    scalerBackends,
  });
  if (!drift) return;

  logger.error(drift.message, {
    agentFacingUrl: resolved.url,
    endpointSource: resolved.source,
    scalerBackends,
  });
  throw new Error(drift.message);
}
