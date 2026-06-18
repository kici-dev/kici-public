/**
 * In-memory peer registry for tracking orchestrator peers in a cluster.
 *
 * Maintains peer state including agent inventories from heartbeats,
 * enabling routing decisions without real-time queries. Follows the
 * same label-matching semantics as agent/registry.ts for consistency.
 */

import type { PeerHeartbeat, PeerCapabilities, ScalerCapacitySummary } from '@kici-dev/engine';

/**
 * Apply the same mandatory-label gate the local label matcher applies, but
 * to a peer's advertised scaler-capacity entry. A scaler-capacity entry is
 * only routable for `requiredLabels` when every label in its `mandatoryLabels`
 * is present in `requiredLabels`. The empty-required-labels short-circuit
 * mirrors `findBackendForLabels`: an empty target only matches a scaler with
 * no gate.
 */
function scalerCapacityMatchesRequiredLabels(
  sc: ScalerCapacitySummary,
  requiredLabels: string[],
): boolean {
  const mandatory = sc.mandatoryLabels ?? [];
  if (requiredLabels.length === 0) {
    // Empty required labels: only scalers without a gate can match.
    return mandatory.length === 0;
  }
  if (mandatory.length === 0) return true;
  const requiredLower = new Set(requiredLabels.map((l) => l.toLowerCase()));
  return mandatory.every((m) => requiredLower.has(m.toLowerCase()));
}

/**
 * Mirror of {@link scalerCapacityMatchesRequiredLabels} for connected
 * peer-side agents. A peer-agent entry is only routable for
 * `requiredLabels` when every label in `agent.mandatoryLabels` appears in
 * `requiredLabels`. Empty `mandatoryLabels` means "no gate" — the agent
 * matches every required-label set the subset filter accepts.
 *
 * Without this, the coordinator would route a job to a peer based on a
 * gated agent's labels, the peer would refuse the dispatch in its local
 * `AgentRegistry.findAvailable` (which now applies the gate), and the
 * job would bounce back to the queue — a wasted round-trip.
 */
function peerAgentMatchesRequiredLabels(
  agent: { mandatoryLabels: string[] },
  requiredLabels: string[],
): boolean {
  const mandatory = agent.mandatoryLabels;
  if (mandatory.length === 0) return true;
  if (requiredLabels.length === 0) return false;
  const required = new Set(requiredLabels);
  return mandatory.every((m) => required.has(m));
}

// --- Types ---

export interface PeerAgentInfo {
  agentId: string;
  labels: string[];
  activeJobs: number;
  maxConcurrency: number;
  platform: string;
  arch: string;
  /**
   * Kubernetes-taint-style mandatory labels inherited from the spawning
   * scaler. Empty for static agents and warm-pool replenishment spawns.
   * Cross-peer routing applies the same gate the local label matcher does:
   * a connected-agent entry only matches when every mandatory label appears
   * in the required label set.
   */
  mandatoryLabels: string[];
  /**
   * Name of the scaler backend that spawned this agent, or null for static
   * (stateful) agents not bound to any scaler. Surfaced in diagnostics so the
   * dashboard can group a peer's agents under the correct scaler row.
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
  /** Cluster role of the peer. */
  role: 'coordinator' | 'worker';
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
  /** Called when a peer's configVersion is higher than the local version. */
  onConfigVersionBehind?: (peerVersion: number) => void;
  /** Called when a peer's registryVersion is higher than the local version. */
  onRegistryVersionBehind?: (peerVersion: number) => void;
  /** Called when a peer transitions to disconnected state. */
  onPeerDisconnected?: (instanceId: string) => void;
}

export class PeerRegistry {
  private readonly peers = new Map<string, PeerInfo>();
  private localConfigVersion = 0;
  private localRegistryVersion = 0;
  private readonly onConfigVersionBehind?: (peerVersion: number) => void;
  private readonly onRegistryVersionBehind?: (peerVersion: number) => void;
  private readonly onPeerDisconnected?: (instanceId: string) => void;

  constructor(options?: PeerRegistryOptions) {
    this.onConfigVersionBehind = options?.onConfigVersionBehind;
    this.onRegistryVersionBehind = options?.onRegistryVersionBehind;
    this.onPeerDisconnected = options?.onPeerDisconnected;
  }

  /**
   * Update the local config version for comparison with peer heartbeats.
   */
  setLocalConfigVersion(version: number): void {
    this.localConfigVersion = version;
  }

  /**
   * Update the local registry version for comparison with peer heartbeats.
   */
  setLocalRegistryVersion(version: number): void {
    this.localRegistryVersion = version;
  }

  /**
   * Add or update a peer entry. Sets initial connected state to true.
   * If the peer already exists and is connected, preserves capabilities
   * (avoids the incoming handler resetting data set by the outgoing client).
   * On fresh add or disconnected peer, starts with empty capabilities —
   * auth response or first heartbeat will populate fresh data.
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
      // Peer already registered and connected (e.g., outgoing PeerClient already
      // set capabilities). Update connection metadata but preserve capabilities.
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
      agents: [], // Always start empty — auth response or heartbeat populates
      draining: false, // Fresh connection = not draining
      capabilities: { s3LogAccess: false },
      term: 0,
      leaderId: null,
      scalerCapacity: undefined, // Always start empty
      configVersion: 0,
      registryVersion: 0,
      role: info.role ?? 'coordinator',
    });
  }

  /**
   * Remove a peer entirely from the registry.
   */
  removePeer(instanceId: string): void {
    this.peers.delete(instanceId);
  }

  /**
   * Update peer state from a heartbeat message.
   * Updates agent inventory, draining status, capabilities, term, leaderId,
   * and lastHeartbeatAt timestamp.
   */
  updateHeartbeat(instanceId: string, heartbeat: PeerHeartbeat): void {
    const peer = this.peers.get(instanceId);
    if (!peer) return;

    peer.agents = heartbeat.agents.map((a) => ({
      agentId: a.agentId,
      labels: [...a.labels],
      activeJobs: a.activeJobs,
      maxConcurrency: a.maxConcurrency,
      platform: a.platform,
      arch: a.arch,
      // Legacy peers omit `mandatoryLabels`; the schema's `.default([])`
      // surfaces it as the empty array (no gate), matching pre-gate
      // routing behavior.
      mandatoryLabels: [...(a.mandatoryLabels ?? [])],
      // Scaler binding for diagnostics grouping; null/omitted for static agents.
      scalerName: a.scalerName ?? null,
    }));
    peer.draining = heartbeat.draining;
    peer.capabilities = { ...heartbeat.capabilities };
    peer.scalerCapacity = heartbeat.scalerCapacity
      ? heartbeat.scalerCapacity.map((sc) => ({ ...sc }))
      : undefined;
    peer.term = heartbeat.term;
    peer.leaderId = heartbeat.leaderId;
    peer.configVersion = heartbeat.configVersion ?? 0;
    peer.registryVersion = heartbeat.registryVersion ?? 0;
    peer.lastHeartbeatAt = heartbeat.timestamp;
    // OS metadata (optional fields, only update if present)
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

    // Auto-remediation: if peer has newer config, trigger reload
    if (
      peer.configVersion > 0 &&
      this.localConfigVersion > 0 &&
      peer.configVersion > this.localConfigVersion &&
      this.onConfigVersionBehind
    ) {
      this.onConfigVersionBehind(peer.configVersion);
    }

    // Auto-remediation: if peer has newer registry, trigger reload
    if (
      peer.registryVersion > 0 &&
      this.localRegistryVersion > 0 &&
      peer.registryVersion > this.localRegistryVersion &&
      this.onRegistryVersionBehind
    ) {
      this.onRegistryVersionBehind(peer.registryVersion);
    }
  }

  /**
   * Get a single peer by instanceId.
   */
  getPeer(instanceId: string): PeerInfo | undefined {
    return this.peers.get(instanceId);
  }

  /**
   * Get all tracked peers.
   */
  getAllPeers(): PeerInfo[] {
    return [...this.peers.values()];
  }

  /**
   * Get only connected peers.
   */
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
   *    AND its label sets overlap with the required label sets (same
   *    intersection semantics as agent matching).
   *
   * Excludes draining peers and disconnected peers.
   *
   * @param labelSets - Array of label sets. A peer matches if ANY of its
   *   agents or scaler backends match ANY of the label sets with capacity.
   */
  findPeersWithCapacity(labelSets: string[][]): PeerInfo[] {
    const result: PeerInfo[] = [];

    for (const peer of this.peers.values()) {
      // Skip disconnected or draining peers
      if (!peer.connected || peer.draining) continue;

      // Check 1: any connected agent matches with capacity
      const hasAgentCapacity = peer.agents.some((agent) => {
        // Must have capacity
        if (agent.activeJobs >= agent.maxConcurrency) return false;

        // Must match at least one label set (subset + agent-side gate).
        return labelSets.some((requiredLabels) => {
          if (!peerAgentMatchesRequiredLabels(agent, requiredLabels)) return false;
          if (requiredLabels.length === 0) return true;
          const agentLabels = new Set(agent.labels);
          return requiredLabels.every((label) => agentLabels.has(label));
        });
      });

      if (hasAgentCapacity) {
        result.push(peer);
        continue;
      }

      // Check 2: scaler-advertised capacity with matching labels
      if (peer.scalerCapacity) {
        const hasScalerCapacity = peer.scalerCapacity.some((sc) => {
          // Must have capacity to spawn more agents
          if (sc.activeCount >= sc.maxAgents) return false;

          // Check if any scaler label set matches any required label set
          return labelSets.some((requiredLabels) => {
            if (!scalerCapacityMatchesRequiredLabels(sc, requiredLabels)) return false;
            return sc.labelSets.some((scalerLabels) => {
              const scalerLabelSet = new Set(scalerLabels);
              return requiredLabels.every((label) => scalerLabelSet.has(label));
            });
          });
        });

        if (hasScalerCapacity) {
          result.push(peer);
        }
      }
    }

    return result;
  }

  /**
   * Find peers whose agents or scaler backends match any of the given label sets,
   * regardless of current capacity. Used to differentiate "no peer handles this label"
   * from "peers exist but are at capacity".
   *
   * Excludes disconnected and draining peers.
   */
  findPeersWithLabels(labelSets: string[][]): PeerInfo[] {
    const result: PeerInfo[] = [];

    for (const peer of this.peers.values()) {
      if (!peer.connected || peer.draining) continue;

      // Check agents (no capacity filter; subset + agent-side gate)
      const hasMatchingAgent = peer.agents.some((agent) =>
        labelSets.some((requiredLabels) => {
          if (!peerAgentMatchesRequiredLabels(agent, requiredLabels)) return false;
          if (requiredLabels.length === 0) return true;
          const agentLabels = new Set(agent.labels);
          return requiredLabels.every((label) => agentLabels.has(label));
        }),
      );

      if (hasMatchingAgent) {
        result.push(peer);
        continue;
      }

      // Check scaler backends (no capacity filter)
      if (peer.scalerCapacity) {
        const hasMatchingScaler = peer.scalerCapacity.some((sc) =>
          labelSets.some((requiredLabels) => {
            if (!scalerCapacityMatchesRequiredLabels(sc, requiredLabels)) return false;
            return sc.labelSets.some((scalerLabels) => {
              const scalerLabelSet = new Set(scalerLabels);
              return requiredLabels.every((label) => scalerLabelSet.has(label));
            });
          }),
        );

        if (hasMatchingScaler) {
          result.push(peer);
        }
      }
    }

    return result;
  }

  /**
   * Mark a peer as disconnected and immediately evict its capabilities.
   * No grace period — disconnected peers have no usable agents or scaler capacity.
   */
  markDisconnected(instanceId: string): void {
    const peer = this.peers.get(instanceId);
    if (peer && peer.connected) {
      peer.connected = false;
      // Immediately evict capabilities — no grace period
      peer.agents = [];
      peer.scalerCapacity = undefined;
      // Notify Raft so it can re-evaluate election state (e.g., self-elect
      // when all peers disconnect in a 2-node cluster).
      this.onPeerDisconnected?.(instanceId);
    }
  }

  /**
   * Mark a peer as connected.
   */
  markConnected(instanceId: string): void {
    const peer = this.peers.get(instanceId);
    if (peer) {
      peer.connected = true;
    }
  }

  /**
   * Check if a peer's last heartbeat is older than the given threshold.
   */
  isStale(instanceId: string, thresholdMs: number): boolean {
    const peer = this.peers.get(instanceId);
    if (!peer) return true;
    return Date.now() - peer.lastHeartbeatAt > thresholdMs;
  }

  /**
   * Total number of tracked peers (connected + disconnected).
   */
  getPeerCount(): number {
    return this.peers.size;
  }

  /**
   * Number of currently connected peers.
   */
  getConnectedPeerCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.connected) count++;
    }
    return count;
  }

  /**
   * Get count of connected coordinator (non-worker) peers.
   * Used for Raft quorum calculations — workers don't participate in elections.
   */
  getConnectedCoordinatorPeerCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.connected && peer.role !== 'worker') count++;
    }
    return count;
  }

  /**
   * Evict stale peers whose last heartbeat exceeds the timeout.
   * Marks them as disconnected and clears their capabilities.
   * Returns the list of evicted peer instanceIds.
   *
   * called on a timer by the coordinator
   * (2 missed heartbeats at 30s interval = 60s default timeout).
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

  /**
   * Get all peers with role=worker.
   */
  getWorkerPeers(): PeerInfo[] {
    return [...this.peers.values()].filter((p) => p.role === 'worker');
  }

  /**
   * Get all peers with role=coordinator.
   */
  getCoordinatorPeers(): PeerInfo[] {
    return [...this.peers.values()].filter((p) => p.role === 'coordinator');
  }
}
