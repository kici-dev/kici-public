/**
 * Version and environment context for an issue report. A report without it
 * costs a support round-trip, so it never fails: the client-side half always
 * resolves, and component versions are added only when the authenticated probe
 * reached the Platform.
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
  /**
   * Where the orchestrator's config files live on its host, so the bundle
   * reader knows which files to ask for. Paths only, never contents; null when
   * not reported.
   */
  configPaths: {
    envFile: string | null;
    scalerConfig: string | null;
    composeFile: string | null;
  };
}

export interface ReportIdentity {
  kiciCliVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  protocolVersion: number;
  /**
   * Every orchestrator the probe saw, not just the first: a report about a
   * routing problem is usually about which of several answered.
   */
  orchestrators: OrchestratorIdentity[];
  /**
   * The newest KiCI version the Platform knows about: an upgrade hint, NOT the
   * Platform's own version, which the diagnostics response does not carry.
   */
  latestKnownVersion?: string;
  /** Why component versions are missing, when the probe could not run. */
  probeError?: string;
}

/**
 * `probe` is the `kici doctor` `ProbeOutcome`, passed in rather than
 * re-fetched: no second round trip, and every path is testable without network.
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
    // Not logged in, or no active org: a local-only bundle is still useful.
    identity.probeError = 'not authenticated; component versions unavailable';
    return identity;
  }

  if (!probe.ok) {
    identity.probeError = `${probe.kind}: ${probe.message}`;
    return identity;
  }

  identity.orchestrators = probe.infra.orchestrators.map((o) => ({
    // clusterName is optional on the wire; an unnamed connection is labelled, not dropped.
    clusterName: o.clusterName ?? '(unnamed)',
    version: o.version ?? null,
    mode: o.mode ?? null,
    connected: o.connected,
    configPaths: {
      envFile: o.configPaths?.envFile ?? null,
      scalerConfig: o.configPaths?.scalerConfig ?? null,
      composeFile: o.configPaths?.composeFile ?? null,
    },
  }));
  if (probe.infra.latestVersion) identity.latestKnownVersion = probe.infra.latestVersion;

  return identity;
}
