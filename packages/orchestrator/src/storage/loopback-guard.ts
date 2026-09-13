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
 * Backends that place the agent outside the orchestrator's loopback (separate
 * netns, microVM, or host) whenever the entry does not say otherwise.
 * `kubernetes` is included defensively even though `ScalerEntry.type` excludes
 * it today.
 *
 * Backend type alone is an imprecise signal — a `bare-metal` scaler may spawn
 * on this very machine or on a rack of remote hosts — so it is only the
 * fallback. When an entry declares its own `orchestratorUrl`, that URL says
 * where the agent will be, and `scalerIsColocated` reads it instead.
 */
export const NON_COLOCATED_BACKENDS: ReadonlySet<ScalerBackendType> = new Set([
  ScalerBackendType.enum.container,
  ScalerBackendType.enum['bare-metal'],
  ScalerBackendType.enum.firecracker,
  ScalerBackendType.enum.kubernetes,
]);

/**
 * Rewrite an IPv4-mapped IPv6 address to the dotted quad it carries, so both
 * predicates below decide it on its real IPv4 value. Returns null for anything
 * that is not such an address.
 *
 * Both spellings occur: an operator writes `::ffff:127.0.0.1`, and the WHATWG
 * URL parser serializes that same literal to the hex form `::ffff:7f00:1`, so
 * `parseHost` hands the hex form to `isLoopbackHost`.
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
 * Answers "could an agent in another netns/VM/host reach this address?" — the
 * question a DESTINATION URL asks. A wildcard (`0.0.0.0`, `::`) is not a
 * destination at all, so it is reported as loopback here.
 *
 * For a listener's bind address the question is the opposite one; use
 * `isLoopbackBind`.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = normalizeHost(hostname);
  if (h === 'localhost') return true;
  if (h === '::1' || h === '::') return true;
  if (h === '0.0.0.0') return true;
  return isIpv4Loopback(h);
}

/**
 * Answers "does a listener on this address stay on this machine?" — the
 * question a BIND address asks. A wildcard (`0.0.0.0`, `::`) accepts every
 * interface, so it is NOT loopback here, which is the one case where this
 * predicate and `isLoopbackHost` disagree.
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
 * An entry that declares its own `orchestratorUrl` has already stated where its
 * agents will connect from: a loopback URL there means the agent runs beside
 * this process, so a loopback storage URL is reachable for it. That is exactly
 * the local dev plane's shape — its scalers point at `ws://127.0.0.1:<port>/ws`
 * — and reading the URL is what lets the plane keep a loopback storage base
 * instead of advertising a LAN address to satisfy a type-only check.
 *
 * With no `orchestratorUrl`, the backend type is the only signal left.
 */
function scalerIsColocated(entry: { type: ScalerBackendType; orchestratorUrl?: string }): boolean {
  if (entry.orchestratorUrl) {
    const host = parseHost(entry.orchestratorUrl);
    if (host) return isLoopbackHost(host);
  }
  return !NON_COLOCATED_BACKENDS.has(entry.type);
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
 * (`ws/agent-handler.ts`), so a listener on a routable address hands anyone who
 * can reach the port a registered agent: it receives dispatched jobs — with the
 * org's resolved secrets in hybrid mode — and streams results back as the
 * operator's own agent. No credential is involved anywhere in that sequence.
 *
 * `none` is a local-development affordance, and any bind other hosts can reach
 * is never an intended pairing with it. The one-shot startup warning that used
 * to be the only signal was demonstrably not enough — the local dev plane
 * shipped in exactly this state — so this refuses, following the sibling guard
 * above: an orchestrator misconfiguration that produces a confusing failure
 * later must refuse to start with an actionable message.
 *
 * The bind question is `isLoopbackBind`, not `isLoopbackHost`. The default
 * `KICI_HOST` is the wildcard `0.0.0.0`, which `isLoopbackHost` reports as
 * loopback because a wildcard is not a reachable destination — true of a
 * storage URL, and the opposite of what a listener on it does. So the guard
 * covers the default bind, which is the configuration an operator reaches
 * without setting `KICI_HOST` at all.
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
