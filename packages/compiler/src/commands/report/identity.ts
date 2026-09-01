/**
 * Version and environment context for an issue report.
 *
 * A report without version context costs a support round-trip before anyone can
 * even reproduce the problem, so this is collected first and never fails: the
 * client-side half always resolves, and the component versions are folded in
 * only when the authenticated probe actually reached the Platform.
 */

import { PROTOCOL_VERSION } from '@kici-dev/engine';
import type { ProbeOutcome } from '../doctor.js';

declare const KICI_VERSION: string;

/** One orchestrator the caller's org has connected, and what it is running. */
export interface OrchestratorIdentity {
  clusterName: string;
  version: string | null;
  mode: string | null;
  connected: boolean;
}

export interface ReportIdentity {
  kiciCliVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  /** The wire protocol this CLI speaks. */
  protocolVersion: number;
  /**
   * Every orchestrator the probe saw, not just the first: a report about a
   * routing problem is usually about which of several answered.
   */
  orchestrators: OrchestratorIdentity[];
  /**
   * The newest KiCI version the Platform knows about, when it told us. This is
   * an upgrade hint, NOT the Platform's own version — the diagnostics response
   * carries no such field, and inventing one would put a fabricated value in a
   * bundle a human will read as fact.
   */
  latestKnownVersion?: string;
  /** Why component versions are missing, when the probe could not run. */
  probeError?: string;
}

/**
 * Build the identity block.
 *
 * `probe` is the same `ProbeOutcome` `kici doctor` already performs — one
 * authenticated infrastructure read — passed in rather than re-fetched so a
 * report never issues a second round trip for data the caller may already
 * hold, and so every path is testable without network.
 */
export function collectIdentity(probe: ProbeOutcome | null): ReportIdentity {
  const identity: ReportIdentity = {
    kiciCliVersion: typeof KICI_VERSION !== 'undefined' ? KICI_VERSION : '0.0.1',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    protocolVersion: PROTOCOL_VERSION,
    orchestrators: [],
  };

  if (probe === null) {
    // Not logged in, or no active org — a local-only bundle is still useful.
    identity.probeError = 'not authenticated; component versions unavailable';
    return identity;
  }

  if (!probe.ok) {
    identity.probeError = `${probe.kind}: ${probe.message}`;
    return identity;
  }

  identity.orchestrators = probe.infra.orchestrators.map((o) => ({
    // The wire schema makes clusterName optional; a connection that never
    // named itself is still worth reporting, so it is labelled rather than
    // dropped from the list.
    clusterName: o.clusterName ?? '(unnamed)',
    version: o.version ?? null,
    mode: o.mode ?? null,
    connected: o.connected,
  }));
  if (probe.infra.latestVersion) identity.latestKnownVersion = probe.infra.latestVersion;

  return identity;
}
