/**
 * Startup guard: an orchestrator running non-co-located agents must not hand them a loopback
 * storage URL, which only a co-located process reaches (a scaled agent fails with an opaque
 * ECONNREFUSED). It refuses to start with an actionable error instead.
 */
import { ScalerBackendType } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import type { AppConfig } from '../config.js';
import type { ScalerConfig } from '../scaler/types.js';

const logger = createLogger({ prefix: 'storage' });

/**
 * Backends that place the agent outside the orchestrator's loopback (separate netns, microVM,
 * or host) unless the entry says otherwise. `kubernetes` is included defensively although
 * `ScalerEntry.type` excludes it.
 *
 * Backend type is only the fallback signal (a `bare-metal` scaler may spawn locally or
 * remotely): an entry's own `orchestratorUrl` takes precedence in `scalerIsColocated`.
 */
export const NON_COLOCATED_BACKENDS: ReadonlySet<ScalerBackendType> = new Set([
  ScalerBackendType.enum.container,
  ScalerBackendType.enum['bare-metal'],
  ScalerBackendType.enum.firecracker,
  ScalerBackendType.enum.kubernetes,
]);

/**
 * Rewrite an IPv4-mapped IPv6 address to its dotted quad, so the predicates below decide it on
 * its real IPv4 value; null for anything else. Both spellings occur: an operator writes
 * `::ffff:127.0.0.1`, and the WHATWG URL parser serializes it to `::ffff:7f00:1`.
 */
function unmapIpv4(host: string): string | null {
  const dotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Trim, lowercase, strip the brackets an IPv6 literal may carry, and reduce an
 * IPv4-mapped IPv6 address to its dotted quad.
 */
function normalizeHost(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  const h = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return unmapIpv4(h) ?? h;
}

/** True for a dotted-quad address inside 127.0.0.0/8. */
function isIpv4Loopback(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) && octets[0] === 127;
}

/**
 * Whether a DESTINATION URL host is unreachable from another netns/VM/host. A wildcard
 * (`0.0.0.0`, `::`) is not a destination, so it counts as loopback here. For a listener's
 * bind address, use `isLoopbackBind`.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = normalizeHost(hostname);
  if (h === 'localhost') return true;
  if (h === '::1' || h === '::') return true;
  if (h === '0.0.0.0') return true;
  return isIpv4Loopback(h);
}

/**
 * Whether a listener on this BIND address stays on this machine. A wildcard (`0.0.0.0`, `::`)
 * accepts every interface, so it is NOT loopback here: the only disagreement with
 * `isLoopbackHost`.
 */
export function isLoopbackBind(hostname: string): boolean {
  const h = normalizeHost(hostname);
  if (h === 'localhost') return true;
  if (h === '::1') return true;
  return isIpv4Loopback(h);
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
 * Whether a scaler places its agents on this machine.
 *
 * A loopback `orchestratorUrl` on the entry means its agents run beside this process, so a
 * loopback storage URL reaches them. The local dev plane relies on this (its scalers point at
 * `ws://127.0.0.1:<port>/ws`) to keep a loopback storage base instead of advertising a LAN
 * address to satisfy a type-only check. Without `orchestratorUrl`, the backend type decides.
 */
function scalerIsColocated(entry: { type: ScalerBackendType; orchestratorUrl?: string }): boolean {
  if (entry.orchestratorUrl) {
    const host = parseHost(entry.orchestratorUrl);
    if (host) return isLoopbackHost(host);
  }
  return !NON_COLOCATED_BACKENDS.has(entry.type);
}

/**
 * A remediation message when the agent-facing storage URL is a loopback address a
 * non-co-located agent cannot reach; null when the configuration is safe.
 */
export function checkLoopbackAgentEndpoint(input: {
  agentFacingUrl: string | null;
  endpointSource: string;
  fixEnvVar: string;
  scalers: { type: ScalerBackendType; orchestratorUrl?: string }[];
}): { message: string } | null {
  const { agentFacingUrl, endpointSource, fixEnvVar, scalers } = input;
  if (!agentFacingUrl) return null;

  const nonColocated = scalers.filter((s) => !scalerIsColocated(s)).map((s) => s.type);
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
 * The URL an AGENT uses to reach storage, and the env var that fixes a loopback
 * misconfiguration; null when the backend has no agent-facing URL.
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

  const scalers = scalerConfig.scalers.map((s) => ({
    type: s.type,
    orchestratorUrl: s.orchestratorUrl,
  }));
  const drift = checkLoopbackAgentEndpoint({
    agentFacingUrl: resolved.url,
    endpointSource: resolved.source,
    fixEnvVar: resolved.fixEnvVar,
    scalers,
  });
  if (!drift) return;

  logger.error(drift.message, {
    agentFacingUrl: resolved.url,
    endpointSource: resolved.source,
    scalerBackends: scalers.map((s) => s.type),
  });
  throw new Error(drift.message);
}

/**
 * Refuse to start when agent authentication is disabled and the listener is
 * bound to something other than a loopback address.
 *
 * `KICI_AGENT_AUTH=none` answers `auth.success` to any `auth.request`
 * (`ws/agent-handler.ts`), so on a routable address anyone who reaches the port becomes a
 * registered agent with no credential: it receives dispatched jobs (with the org's resolved
 * secrets in hybrid mode) and reports results as the operator's own agent.
 *
 * `none` is a local-development affordance, never intended with a bind other hosts can reach.
 * A startup warning alone proved insufficient, so this refuses to start, like the storage
 * guard above.
 *
 * It uses `isLoopbackBind`, not `isLoopbackHost`: the default `KICI_HOST` is the wildcard
 * `0.0.0.0`, which `isLoopbackHost` reports as loopback, so only `isLoopbackBind` covers the
 * default bind an operator gets without setting `KICI_HOST`.
 */
export function assertAgentAuthBindSafe(config: AppConfig): void {
  if (config.agentAuth !== 'none') return;
  if (isLoopbackBind(config.host)) return;

  const message =
    `Unsafe agent-auth configuration: KICI_AGENT_AUTH=none disables agent ` +
    `authentication, but this orchestrator binds ${config.host} (KICI_HOST), which ` +
    `is reachable from other hosts — a wildcard bind such as 0.0.0.0 or :: accepts ` +
    `every interface on this machine. Any process that can open a WebSocket to this ` +
    `port would register as an agent and be dispatched jobs — with resolved secrets ` +
    `— without presenting a credential. Either set KICI_HOST=127.0.0.1 to keep the ` +
    `listener on this machine, or configure real agent authentication ` +
    `(KICI_AGENT_AUTH=token) and restart.`;
  logger.error(message, { host: config.host, agentAuth: config.agentAuth });
  throw new Error(message);
}
