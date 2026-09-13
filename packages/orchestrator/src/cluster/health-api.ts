/**
 * Cluster health HTTP endpoints.
 *
 * Provides visibility into cluster state for monitoring and debugging:
 * - GET /cluster/health -- overall cluster health status
 * - GET /cluster/peers -- per-peer details including connectivity
 * - GET /cluster/runs -- active execution runs with job counts
 *
 * Follows the existing Hono route factory pattern from routes/health.ts.
 */

import { Hono } from 'hono';
import type { RaftNode } from './raft.js';
import type { PeerRegistry } from './peer-registry.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { AgentRegistry } from '../agent/registry.js';

export interface ClusterHealthRoutesDeps {
  instanceId: string;
  raft: RaftNode;
  peerRegistry: PeerRegistry;
  executionTracker: ExecutionTracker;
  agentRegistry: AgentRegistry;
}

/**
 * Determine overall cluster health status.
 *
 * - healthy: leader exists AND all cluster members connected (or 0 peers = single-node)
 * - degraded: leader exists but some peers disconnected (majority still holds)
 * - unhealthy: no leader OR majority of cluster members disconnected
 *
 * Cluster size includes this node (+1 for self), matching Raft's
 * majority calculation in raft.ts.
 */
function computeClusterStatus(
  hasLeader: boolean,
  totalPeers: number,
  connectedPeers: number,
): 'healthy' | 'degraded' | 'unhealthy' {
  if (!hasLeader) return 'unhealthy';

  // Single-node (no peers): healthy if leader exists
  if (totalPeers === 0) return 'healthy';

  // Cluster size includes self (+1), matching Raft's calculation
  const clusterSize = totalPeers + 1;
  const connectedNodes = connectedPeers + 1; // self is always connected
  const majority = Math.floor(clusterSize / 2) + 1;
  if (connectedNodes < majority) return 'unhealthy';

  // Some peers disconnected but majority still connected
  if (connectedNodes < clusterSize) return 'degraded';

  return 'healthy';
}

/**
 * Create cluster health routes.
 *
 * @param deps - Dependencies for cluster state introspection
 * @returns Hono app with /cluster/health, /cluster/peers, /cluster/runs endpoints
 */
export function createClusterHealthRoutes(deps: ClusterHealthRoutesDeps): Hono {
  const app = new Hono();

  /**
   * GET /cluster/health -- overall cluster health snapshot.
   */
  app.get('/cluster/health', (c) => {
    const totalPeers = deps.peerRegistry.getPeerCount();
    const connectedPeers = deps.peerRegistry.getConnectedPeerCount();
    const leaderId = deps.raft.getLeaderId();
    const hasLeader = leaderId !== null;

    const status = computeClusterStatus(hasLeader, totalPeers, connectedPeers);

    return c.json({
      status,
      instanceId: deps.instanceId,
      role: deps.raft.getRole(),
      term: deps.raft.getCurrentTerm(),
      leaderId,
      peerCount: totalPeers,
      connectedPeers,
      agentCount: deps.agentRegistry.getActiveCount(),
      activeRuns: deps.executionTracker.getActiveRunCount(),
    });
  });

  /**
   * GET /cluster/peers -- per-peer details from the peer registry.
   */
  app.get('/cluster/peers', (c) => {
    const allPeers = deps.peerRegistry.getAllPeers();

    const peers = allPeers.map((peer) => ({
      instanceId: peer.instanceId,
      connectionId: peer.connectionId,
      address: peer.address,
      connected: peer.connected,
      lastHeartbeat: peer.lastHeartbeatAt,
      agentCount: peer.agents.length,
      draining: peer.draining,
      capabilities: peer.capabilities,
      role: peer.role,
      // scalerCapacity is the per-peer scaler advertisement carried in heartbeats;
      // exposing it here lets operators (and E2E setup helpers) verify cross-coord
      // scaler discovery without poking at the registry directly.
      scalerCapacity: peer.scalerCapacity ?? null,
    }));

    return c.json({ peers });
  });

  /**
   * GET /cluster/runs -- active execution runs with job routing summary.
   */
  app.get('/cluster/runs', (c) => {
    const activeRuns = deps.executionTracker.getActiveRuns();
    return c.json({ activeRuns });
  });

  return app;
}
