/**
 * In-memory registry of cluster peers, including heartbeat agent inventories, so
 * routing needs no real-time queries. Label matching follows agent/registry.ts.
 */

import type {
  PeerAuthScheme,
  PeerHeartbeat,
  PeerCapabilities,
  ScalerCapacitySummary,
} from '@kici-dev/engine';
import { canonicalizeLabels, canonicalizeLabelSet } from '@kici-dev/engine';

/**
 * The taint gate for one label set of a peer's scaler-capacity entry, from the
 * index-aligned `labelSetMandatoryLabels`. `null` (the entry routes nothing) when
 * the lengths differ: a misaligned index could under-gate and send a job to a
 * peer that cannot run it.
 */
function scalerGateForLabelSet(sc: ScalerCapacitySummary, index: number): string[] | null {
  const perSet = sc.labelSetMandatoryLabels;
  if (perSet.length !== sc.labelSets.length) return null;
  return perSet[index] ?? [];
}

/**
 * The local label matcher's per-label-set gate, applied to a peer's scaler-capacity
 * entry: routable when SOME label set both supplies every required label and has
 * its gate satisfied by them.
 *
 * Gate and subset are checked on the same label set: separate passes would admit
 * a peer whose gate one set satisfies and whose labels another supplies — a
 * dispatch the peer then refuses locally.
 *
 * The empty-required-labels short-circuit mirrors `findBackendForLabels`: an
 * empty target only matches an ungated label set.
 *
 * Every label comparison in this file folds case (here, and for peer agents in
 * {@link peerAgentMatchesRequiredLabels} and its two call sites), so a peer is
 * selected for the labels its own matcher accepts. Case-sensitive, a scaler
 * declaring `Docker` is invisible cluster-wide to a `runsOn: docker` job its own
 * peer matches locally.
 */
function scalerCapacityMatchesRequiredLabels(
  sc: ScalerCapacitySummary,
  requiredLabels: string[],
): boolean {
  const requiredLower = new Set(requiredLabels.map((l) => l.toLowerCase()));
  return sc.labelSets.some((scalerLabels, i) => {
    const mandatory = scalerGateForLabelSet(sc, i);
    if (mandatory === null) return false;
    if (requiredLabels.length === 0) {
      // Only an ungated label set matches an empty target.
      return mandatory.length === 0;
    }
    if (!mandatory.every((m) => requiredLower.has(m.toLowerCase()))) return false;
    const scalerLabelSet = new Set(scalerLabels.map((l) => l.toLowerCase()));
    return [...requiredLower].every((label) => scalerLabelSet.has(label));
  });
}

/**
 * The gate half of {@link scalerCapacityMatchesRequiredLabels} for connected peer
 * agents: routable only when every `agent.mandatoryLabels` entry is in
 * `requiredLabels`; empty means no gate.
 *
 * Without it, a job routed on a gated agent's labels is refused by the peer's
 * `AgentRegistry.findAvailable` (which applies the gate) and bounces back to the
 * queue — a wasted round-trip.
 */
function peerAgentMatchesRequiredLabels(
  agent: { mandatoryLabels: string[] },
  requiredLabels: string[],
): boolean {
  const mandatory = agent.mandatoryLabels;
  if (mandatory.length === 0) return true;
  if (requiredLabels.length === 0) return false;
  const required = canonicalizeLabelSet(requiredLabels);
  return canonicalizeLabels(mandatory).every((m) => required.has(m));
}

// --- Types ---

/** Which side of a peer link authenticated: the peer dialled us, or we dialled it. */
export enum PeerLinkDirection {
  Inbound = 'inbound',
  Outbound = 'outbound',
}

/** The scheme each direction of a peer link authenticated with; null while that direction is down. */
export interface PeerAuthSchemes {
  inbound: PeerAuthScheme | null;
  outbound: PeerAuthScheme | null;
}

export interface PeerAgentInfo {
  agentId: string;
  labels: string[];
  activeJobs: number;
  maxConcurrency: number;
  platform: string;
  arch: string;
  /**
   * Taint-style mandatory labels inherited from the spawning scaler; empty for
   * static agents and warm-pool replenishment spawns. Cross-peer routing matches
   * only when every one is in the required label set, like the local matcher.
   */
  mandatoryLabels: string[];
  /**
   * The spawning scaler backend, or null for static (stateful) agents; the
   * dashboard groups a peer's agents under this scaler row.
   */
  scalerName?: string | null;
}

export interface PeerInfo {
  instanceId: string;
  connectionId: string;
  address: string | null;
  routingKeys: string[];
  connected: boolean;
  lastHeartbeatAt: number;
  /** When this peer first connected. Distinct from `lastHeartbeatAt`, which moves; this does not. */
  connectedAt: number;
  agents: PeerAgentInfo[];
  draining: boolean;
  capabilities: PeerCapabilities;
  term: number;
  leaderId: string | null;
  /** Scaler-advertised capacity for on-demand backends (from heartbeat). */
  scalerCapacity?: ScalerCapacitySummary[];
  /** Shared config version reported by this peer (0 = unknown/legacy). */
  configVersion: number;
  /** Registry version reported by this peer (0 = unknown/legacy). */
  registryVersion: number;
  /** Cluster-settings version reported by this peer (0 = unknown/legacy). */
  clusterSettingsVersion: number;
  role: 'coordinator' | 'worker';
  authScheme: PeerAuthSchemes;
  // --- OS metadata (from heartbeats) ---
  hostname?: string;
  osRelease?: string;
  totalMemoryMb?: number;
  memoryUsedMb?: number;
  memoryAvailableMb?: number;
  cpuCount?: number;
  uptimeSeconds?: number;
  nodeVersion?: string;
  runningAsUser?: string | null;
  runningAsUid?: number | null;
  version?: string | null;
}

// --- PeerRegistry ---

export interface PeerRegistryOptions {
  /** Each `...VersionBehind` fires when a peer reports a higher version than local. */
  onConfigVersionBehind?: (peerVersion: number) => void;
  onRegistryVersionBehind?: (peerVersion: number) => void;
  onClusterSettingsVersionBehind?: (peerVersion: number) => void;
  onPeerDisconnected?: (instanceId: string) => void;
  /**
   * Fires when the connected set changes (fresh add or markDisconnected), so a
   * coordinator re-reports `cluster.membership` to the Platform before the
   * periodic interval.
   */
  onMembershipChange?: () => void;
}

export class PeerRegistry {
  private readonly peers = new Map<string, PeerInfo>();
  private localConfigVersion = 0;
  private localRegistryVersion = 0;
  private localClusterSettingsVersion = 0;
  private readonly onConfigVersionBehind?: (peerVersion: number) => void;
  private readonly onRegistryVersionBehind?: (peerVersion: number) => void;
  private readonly onClusterSettingsVersionBehind?: (peerVersion: number) => void;
  private readonly onPeerDisconnected?: (instanceId: string) => void;
  private readonly onMembershipChange?: () => void;

  constructor(options?: PeerRegistryOptions) {
    this.onConfigVersionBehind = options?.onConfigVersionBehind;
    this.onRegistryVersionBehind = options?.onRegistryVersionBehind;
    this.onClusterSettingsVersionBehind = options?.onClusterSettingsVersionBehind;
    this.onPeerDisconnected = options?.onPeerDisconnected;
    this.onMembershipChange = options?.onMembershipChange;
  }

  setLocalConfigVersion(version: number): void {
    this.localConfigVersion = version;
  }

  setLocalRegistryVersion(version: number): void {
    this.localRegistryVersion = version;
  }

  /** A worker sets this after pulling a snapshot, so the behind-hook stops re-firing. */
  setLocalClusterSettingsVersion(version: number): void {
    this.localClusterSettingsVersion = version;
  }

  /**
   * Add or update a peer as connected. An already-connected peer keeps its
   * capabilities, so the incoming handler cannot reset what the outgoing client
   * set; a fresh or disconnected peer starts empty until the auth response or
   * first heartbeat fills it.
   */
  addPeer(info: {
    instanceId: string;
    connectionId: string;
    address: string | null;
    routingKeys: string[];
    role?: 'coordinator' | 'worker';
  }): void {
    const existing = this.peers.get(info.instanceId);
    if (existing && existing.connected) {
      existing.connectionId = info.connectionId;
      if (info.address) existing.address = info.address;
      if (info.routingKeys.length > 0) existing.routingKeys = info.routingKeys;
      existing.lastHeartbeatAt = Date.now();
      return;
    }

    this.peers.set(info.instanceId, {
      instanceId: info.instanceId,
      connectionId: info.connectionId,
      address: info.address,
      routingKeys: info.routingKeys,
      connected: true,
      lastHeartbeatAt: Date.now(),
      // Fresh-peer branch only: resetting it on reconnect would make a flapping
      // peer forever "newest" and un-evictable.
      connectedAt: Date.now(),
      agents: [],
      draining: false,
      capabilities: { s3LogAccess: false },
      term: 0,
      leaderId: null,
      scalerCapacity: undefined,
      configVersion: 0,
      registryVersion: 0,
      clusterSettingsVersion: 0,
      role: info.role ?? 'coordinator',
      // Each direction resets its own value on close, so a live direction survives
      // the other re-adding the peer.
      authScheme: existing?.authScheme ?? { inbound: null, outbound: null },
    });
    // The connected set changed; the metadata-only branch above returned early.
    this.onMembershipChange?.();
  }

  /** Record the scheme one direction of the link authenticated with, or null when it closed. */
  setAuthScheme(
    instanceId: string,
    direction: PeerLinkDirection,
    scheme: PeerAuthScheme | null,
  ): void {
    const peer = this.peers.get(instanceId);
    if (!peer) return;
    peer.authScheme = { ...peer.authScheme, [direction]: scheme };
  }

  removePeer(instanceId: string): void {
    this.peers.delete(instanceId);
  }

  /**
   * Apply a heartbeat to the peer's state.
   *
   * Every label is folded here, on ingress, not at each comparison site: an older
   * peer build sends the operator's case (`Docker`), and a `PeerInfo` consumer that
   * forgot to fold would silently stop counting that peer's agents.
   *
   * Identifiers are NOT folded: `agentId`, `scalerName`, and the scaler's
   * `name` / `type` are opaque and case-sensitive.
   */
  updateHeartbeat(instanceId: string, heartbeat: PeerHeartbeat): void {
    const peer = this.peers.get(instanceId);
    if (!peer) return;

    peer.agents = heartbeat.agents.map((a) => ({
      agentId: a.agentId,
      labels: canonicalizeLabels(a.labels),
      activeJobs: a.activeJobs,
      maxConcurrency: a.maxConcurrency,
      platform: a.platform,
      arch: a.arch,
      // Always present on the wire; a static agent carries `[]` (no gate).
      mandatoryLabels: canonicalizeLabels(a.mandatoryLabels),
      scalerName: a.scalerName ?? null,
    }));
    peer.draining = heartbeat.draining;
    peer.capabilities = { ...heartbeat.capabilities };
    peer.scalerCapacity = heartbeat.scalerCapacity
      ? heartbeat.scalerCapacity.map((sc) => ({
          ...sc,
          labelSets: sc.labelSets.map((ls) => canonicalizeLabels(ls)),
          labelSetMandatoryLabels: sc.labelSetMandatoryLabels.map((ls) => canonicalizeLabels(ls)),
        }))
      : undefined;
    peer.term = heartbeat.term;
    peer.leaderId = heartbeat.leaderId;
    peer.configVersion = heartbeat.configVersion ?? 0;
    peer.registryVersion = heartbeat.registryVersion ?? 0;
    peer.clusterSettingsVersion = heartbeat.clusterSettingsVersion ?? 0;
    peer.lastHeartbeatAt = heartbeat.timestamp;
    if (heartbeat.hostname !== undefined) peer.hostname = heartbeat.hostname;
    if (heartbeat.osRelease !== undefined) peer.osRelease = heartbeat.osRelease;
    if (heartbeat.totalMemoryMb !== undefined) peer.totalMemoryMb = heartbeat.totalMemoryMb;
    if (heartbeat.memoryUsedMb !== undefined) peer.memoryUsedMb = heartbeat.memoryUsedMb;
    if (heartbeat.memoryAvailableMb !== undefined)
      peer.memoryAvailableMb = heartbeat.memoryAvailableMb;
    if (heartbeat.cpuCount !== undefined) peer.cpuCount = heartbeat.cpuCount;
    if (heartbeat.uptimeSeconds !== undefined) peer.uptimeSeconds = heartbeat.uptimeSeconds;
    if (heartbeat.nodeVersion !== undefined) peer.nodeVersion = heartbeat.nodeVersion;
    if (heartbeat.runningAsUser !== undefined) peer.runningAsUser = heartbeat.runningAsUser;
    if (heartbeat.runningAsUid !== undefined) peer.runningAsUid = heartbeat.runningAsUid;
    if (heartbeat.version !== undefined) peer.version = heartbeat.version;

    // Auto-remediation: a peer ahead on config or registry triggers a reload; one
    // ahead on cluster settings triggers a snapshot pull (below).
    if (
      peer.configVersion > 0 &&
      this.localConfigVersion > 0 &&
      peer.configVersion > this.localConfigVersion &&
      this.onConfigVersionBehind
    ) {
      this.onConfigVersionBehind(peer.configVersion);
    }

    if (
      peer.registryVersion > 0 &&
      this.localRegistryVersion > 0 &&
      peer.registryVersion > this.localRegistryVersion &&
      this.onRegistryVersionBehind
    ) {
      this.onRegistryVersionBehind(peer.registryVersion);
    }

    // Cluster settings pull the worker-settings snapshot with NO
    // `localClusterSettingsVersion > 0` gate: a worker starts at 0 and must pull
    // the first time a coordinator is ahead.
    if (
      peer.clusterSettingsVersion > 0 &&
      peer.clusterSettingsVersion > this.localClusterSettingsVersion &&
      this.onClusterSettingsVersionBehind
    ) {
      this.onClusterSettingsVersionBehind(peer.clusterSettingsVersion);
    }
  }

  getPeer(instanceId: string): PeerInfo | undefined {
    return this.peers.get(instanceId);
  }

  getAllPeers(): PeerInfo[] {
    return [...this.peers.values()];
  }

  getConnectedPeers(): PeerInfo[] {
    return [...this.peers.values()].filter((p) => p.connected);
  }

  /**
   * Find peers whose agents or scaler backends match any of the given label
   * sets AND have available capacity.
   *
   * A peer matches if EITHER:
   * 1. Connected agents: at least one agent's labels are a superset of a
   *    required label set with activeJobs < maxConcurrency.
   * 2. Scaler capacity: at least one scaler backend has activeCount < maxAgents
   *    AND one of its label sets is a superset of a required label set and
   *    passes that set's mandatory-label gate (the same subset-plus-gate check
   *    as agent matching).
   *
   * Excludes draining peers and disconnected peers.
   */
  findPeersWithCapacity(labelSets: string[][]): PeerInfo[] {
    const result: PeerInfo[] = [];

    for (const peer of this.peers.values()) {
      if (!peer.connected || peer.draining) continue;

      const hasAgentCapacity = peer.agents.some((agent) => {
        if (agent.activeJobs >= agent.maxConcurrency) return false;
        // Subset + agent-side gate.
        return labelSets.some((requiredLabels) => {
          if (!peerAgentMatchesRequiredLabels(agent, requiredLabels)) return false;
          if (requiredLabels.length === 0) return true;
          const agentLabels = canonicalizeLabelSet(agent.labels);
          return canonicalizeLabels(requiredLabels).every((label) => agentLabels.has(label));
        });
      });

      if (hasAgentCapacity) {
        result.push(peer);
        continue;
      }

      if (peer.scalerCapacity) {
        const hasScalerCapacity = peer.scalerCapacity.some((sc) => {
          if (sc.activeCount >= sc.maxAgents) return false;
          return labelSets.some((requiredLabels) =>
            scalerCapacityMatchesRequiredLabels(sc, requiredLabels),
          );
        });

        if (hasScalerCapacity) {
          result.push(peer);
        }
      }
    }

    return result;
  }

  /**
   * Like {@link findPeersWithCapacity} without the capacity filter, to tell "no
   * peer handles this label" from "peers exist but are at capacity".
   */
  findPeersWithLabels(labelSets: string[][]): PeerInfo[] {
    const result: PeerInfo[] = [];

    for (const peer of this.peers.values()) {
      if (!peer.connected || peer.draining) continue;

      const hasMatchingAgent = peer.agents.some((agent) =>
        labelSets.some((requiredLabels) => {
          if (!peerAgentMatchesRequiredLabels(agent, requiredLabels)) return false;
          if (requiredLabels.length === 0) return true;
          const agentLabels = canonicalizeLabelSet(agent.labels);
          return canonicalizeLabels(requiredLabels).every((label) => agentLabels.has(label));
        }),
      );

      if (hasMatchingAgent) {
        result.push(peer);
        continue;
      }

      if (peer.scalerCapacity) {
        const hasMatchingScaler = peer.scalerCapacity.some((sc) =>
          labelSets.some((requiredLabels) =>
            scalerCapacityMatchesRequiredLabels(sc, requiredLabels),
          ),
        );

        if (hasMatchingScaler) {
          result.push(peer);
        }
      }
    }

    return result;
  }

  /**
   * Evict capabilities immediately, with no grace period: a disconnected peer has
   * no usable agents or scaler capacity.
   */
  markDisconnected(instanceId: string): void {
    const peer = this.peers.get(instanceId);
    if (peer && peer.connected) {
      peer.connected = false;
      peer.agents = [];
      peer.scalerCapacity = undefined;
      // Raft re-evaluates election state (e.g. self-elects when every peer of a
      // 2-node cluster disconnects).
      this.onPeerDisconnected?.(instanceId);
      this.onMembershipChange?.();
    }
  }

  markConnected(instanceId: string): void {
    const peer = this.peers.get(instanceId);
    if (peer) {
      peer.connected = true;
    }
  }

  /** An unknown peer counts as stale. */
  isStale(instanceId: string, thresholdMs: number): boolean {
    const peer = this.peers.get(instanceId);
    if (!peer) return true;
    return Date.now() - peer.lastHeartbeatAt > thresholdMs;
  }

  /** Connected and disconnected. */
  getPeerCount(): number {
    return this.peers.size;
  }

  getConnectedPeerCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.connected) count++;
    }
    return count;
  }

  /** For Raft quorum: workers do not take part in elections. */
  getConnectedCoordinatorPeerCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.connected && peer.role !== 'worker') count++;
    }
    return count;
  }

  /**
   * Mark peers past the heartbeat timeout disconnected; returns their ids. The
   * coordinator calls it on a timer (2 missed heartbeats at 30s = 60s default).
   */
  evictStalePeers(staleTimeoutMs: number): string[] {
    const evicted: string[] = [];
    const now = Date.now();

    for (const peer of this.peers.values()) {
      if (!peer.connected) continue;
      if (now - peer.lastHeartbeatAt > staleTimeoutMs) {
        this.markDisconnected(peer.instanceId);
        evicted.push(peer.instanceId);
      }
    }

    return evicted;
  }

  getWorkerPeers(): PeerInfo[] {
    return [...this.peers.values()].filter((p) => p.role === 'worker');
  }

  /**
   * A peer advertising no role registers as a coordinator (`addPeer`), so a worker
   * predating the role field is not counted: under-counting errs permissive and
   * self-heals as workers upgrade.
   */
  getConnectedWorkerPeers(): PeerInfo[] {
    return [...this.peers.values()].filter((p) => p.connected && p.role === 'worker');
  }

  getCoordinatorPeers(): PeerInfo[] {
    return [...this.peers.values()].filter((p) => p.role === 'coordinator');
  }
}
