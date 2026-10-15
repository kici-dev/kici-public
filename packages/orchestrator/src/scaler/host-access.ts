/**
 * What a scaled agent may reach on the orchestrator's own host.
 *
 * An agent container or Firecracker VM sends its packets to one of the host's
 * addresses — a bridge gateway, the host's LAN address — and those are
 * delivered on the netfilter input hook, which the backends' `forward` rules
 * never see: without an `input` chain a sandbox reaches every port on the host.
 * These helpers resolve the narrow set it needs, in the `hostAccess`
 * vocabulary an operator writes in `scalers.yaml`.
 */

import type { NetworkPolicy } from '@kici-dev/shared/net';
import type { AppConfig } from '../config.js';
import { resolveAgentFacingStorage } from '../storage/loopback-guard.js';

const DNS_PORT = 53;

const IMPLICIT_PORTS: Record<string, string> = {
  'http:': '80',
  'ws:': '80',
  'https:': '443',
  'wss:': '443',
};

const IPV4_LITERAL_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * `explicit` distinguishes a port the URL names from one its scheme implies; it
 * decides whether a storage endpoint is host-local or public — see
 * {@link storageHostAccessEntries}.
 */
function portOf(url: string): { port: string; explicit: boolean; hostname: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.port.length > 0) {
    return { port: parsed.port, explicit: true, hostname: parsed.hostname };
  }
  const implicit = IMPLICIT_PORTS[parsed.protocol];
  if (implicit === undefined) return null;
  return { port: implicit, explicit: false, hostname: parsed.hostname };
}

/**
 * Host-access entries for the agent-facing storage endpoint, when it is a
 * service on this host rather than a remote one.
 *
 * A scaled agent connects to storage directly — that is why
 * `assertAgentReachableStorage` refuses to start on a loopback endpoint — so an
 * orchestrator-port-only default would cut off every deployment running its own
 * object store beside the orchestrator.
 *
 * Only two shapes are recognised:
 *
 *  - **An IP literal.** The entry is scoped to that exact address and port.
 *  - **A name with an explicit port.** No address rule can be built for a name
 *    that may move, so the entry names the port on any host address.
 *
 * A name with no port is a public endpoint (`https://…`), which the agent
 * reaches through the host over the `forward` hook and which no input rule
 * governs. Emitting `*:443` for it would open a host port for nothing.
 */
export function storageHostAccessEntries(config: AppConfig): string[] {
  const resolved = resolveAgentFacingStorage(config);
  if (!resolved?.url) return [];

  const parsed = portOf(resolved.url);
  if (!parsed) return [];

  if (IPV4_LITERAL_RE.test(parsed.hostname)) return [`${parsed.hostname}:${parsed.port}`];
  if (parsed.explicit) return [`*:${parsed.port}`];
  return [];
}

/**
 * Resolve the `hostAccess` policy for one agent sandbox.
 *
 * An explicit `hostAccess` on the label set wins outright: host reachability is
 * operator-configurable policy, and an operator who names it has said exactly
 * what this class of agent may reach.
 *
 * The default is the set an agent cannot work without:
 *
 *  - **DNS on the bridge gateway.** Rootful podman resolves there, so a sandbox
 *    with no such rule cannot resolve the orchestrator's own hostname. Docker
 *    resolves inside the container's netns and is unaffected either way.
 *  - **The orchestrator's port**, on any host address, since the address the
 *    agent was told to dial is not knowable from here.
 *  - **Whatever host services the orchestrator itself directed the agent at**,
 *    which today means its object storage.
 */
export function resolveAgentHostAccess(input: {
  policy: NetworkPolicy | undefined;
  orchestratorUrl: string;
  gateway: string;
  hostServices?: string[];
}): string[] {
  if (input.policy?.hostAccess) return input.policy.hostAccess;

  const entries = [`${input.gateway}:${DNS_PORT}`];
  const orchestrator = portOf(input.orchestratorUrl);
  if (orchestrator) entries.push(`*:${orchestrator.port}`);
  entries.push(...(input.hostServices ?? []));

  // The same service can appear twice (storage on the orchestrator's own port);
  // duplicate accepts are inert but make the chain harder to read.
  return [...new Set(entries)];
}
