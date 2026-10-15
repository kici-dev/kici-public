/**
 * Cluster health HTTP endpoints:
 * - GET /cluster/health -- overall cluster health status
 * - GET /cluster/peers -- per-peer details including connectivity
 * - GET /cluster/runs -- active execution runs with job counts
 *
 * Follows the Hono route factory pattern of routes/health.ts.
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
 * - healthy: leader exists AND all cluster members connected (or 0 peers = single-node)
 * - degraded: leader exists but some peers disconnected (majority still holds)
 * - unhealthy: no leader OR majority of cluster members disconnected
 *
 * Cluster size is every peer, workers included, plus this node; Raft's
 * majority in raft.ts counts connected coordinator peers only.
 */
function computeClusterStatus(
  hasLeader: boolean,
  totalPeers: number,
  connectedPeers: number,
): 'healthy' | 'degraded' | 'unhealthy' {
  if (!hasLeader) return 'unhealthy';

  if (totalPeers === 0) return 'healthy';

  const clusterSize = totalPeers + 1;
  const connectedNodes = connectedPeers + 1; // self is always connected
  const majority = Math.floor(clusterSize / 2) + 1;
  if (connectedNodes < majority) return 'unhealthy';

  if (connectedNodes < clusterSize) return 'degraded';

  return 'healthy';
}

export function createClusterHealthRoutes(deps: ClusterHealthRoutesDeps): Hono {
  const app = new Hono();

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
      authScheme: peer.authScheme,
      // The heartbeat's scaler advertisement, exposed so operators and tests can
      // verify cross-coordinator scaler discovery.
      scalerCapacity: peer.scalerCapacity ?? null,
    }));

    return c.json({ peers });
  });

  app.get('/cluster/runs', (c) => {
    const activeRuns = deps.executionTracker.getActiveRuns();
    return c.json({ activeRuns });
  });

  return app;
}
