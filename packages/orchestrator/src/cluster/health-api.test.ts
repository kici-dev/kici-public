import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createClusterHealthRoutes, type ClusterHealthRoutesDeps } from './health-api.js';
import type { RaftNode, RaftRole } from './raft.js';
import type { PeerRegistry, PeerInfo } from './peer-registry.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { AgentRegistry } from '../agent/registry.js';

// ── Mock helpers ────────────────────────────────────────────────

function mockRaft(
  overrides: {
    role?: RaftRole;
    term?: number;
    leaderId?: string | null;
  } = {},
): RaftNode {
  const leaderId = 'leaderId' in overrides ? overrides.leaderId : 'orch-1';
  return {
    getRole: vi.fn().mockReturnValue(overrides.role ?? 'leader'),
    getCurrentTerm: vi.fn().mockReturnValue(overrides.term ?? 3),
    getLeaderId: vi.fn().mockReturnValue(leaderId),
    isLeader: vi.fn().mockReturnValue((overrides.role ?? 'leader') === 'leader'),
  } as unknown as RaftNode;
}

function mockPeerRegistry(
  overrides: {
    peers?: PeerInfo[];
    peerCount?: number;
    connectedPeerCount?: number;
  } = {},
): PeerRegistry {
  const peers = overrides.peers ?? [];
  return {
    getAllPeers: vi.fn().mockReturnValue(peers),
    getPeerCount: vi.fn().mockReturnValue(overrides.peerCount ?? peers.length),
    getConnectedPeerCount: vi
      .fn()
      .mockReturnValue(overrides.connectedPeerCount ?? peers.filter((p) => p.connected).length),
  } as unknown as PeerRegistry;
}

function mockExecutionTracker(
  overrides: {
    activeRunCount?: number;
    activeRuns?: Array<{
      runId: string;
      workflowName: string;
      status: string;
      jobs: { total: number; completed: number; failed: number; running: number };
    }>;
  } = {},
): ExecutionTracker {
  return {
    getActiveRunCount: vi.fn().mockReturnValue(overrides.activeRunCount ?? 0),
    getActiveRuns: vi.fn().mockReturnValue(overrides.activeRuns ?? []),
  } as unknown as ExecutionTracker;
}

function mockAgentRegistry(
  overrides: {
    activeCount?: number;
  } = {},
): AgentRegistry {
  return {
    getActiveCount: vi.fn().mockReturnValue(overrides.activeCount ?? 0),
  } as unknown as AgentRegistry;
}

function createPeer(overrides: Partial<PeerInfo> = {}): PeerInfo {
  return {
    instanceId: overrides.instanceId ?? 'peer-1',
    connectionId: overrides.connectionId ?? 'conn-1',
    address: overrides.address ?? 'ws://10.0.0.1:4000',
    routingKeys: overrides.routingKeys ?? ['github:42'],
    connected: overrides.connected ?? true,
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? 1708286400000,
    agents: overrides.agents ?? [],
    draining: overrides.draining ?? false,
    capabilities: overrides.capabilities ?? { s3LogAccess: true },
    term: overrides.term ?? 3,
    leaderId: overrides.leaderId ?? 'orch-1',
    configVersion: overrides.configVersion ?? 0,
    registryVersion: overrides.registryVersion ?? 0,
    role: overrides.role ?? 'coordinator',
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('cluster health API', () => {
  let deps: ClusterHealthRoutesDeps;

  beforeEach(() => {
    deps = {
      instanceId: 'orch-1',
      raft: mockRaft(),
      peerRegistry: mockPeerRegistry(),
      executionTracker: mockExecutionTracker(),
      agentRegistry: mockAgentRegistry(),
    };
  });

  // ── GET /cluster/health ──────────────────────────────────────

  describe('GET /cluster/health', () => {
    it('should return healthy status when leader with all peers connected', async () => {
      deps.peerRegistry = mockPeerRegistry({
        peerCount: 2,
        connectedPeerCount: 2,
      });
      deps.agentRegistry = mockAgentRegistry({ activeCount: 5 });
      deps.executionTracker = mockExecutionTracker({ activeRunCount: 3 });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/health');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe('healthy');
      expect(body.instanceId).toBe('orch-1');
      expect(body.role).toBe('leader');
      expect(body.term).toBe(3);
      expect(body.leaderId).toBe('orch-1');
      expect(body.peerCount).toBe(2);
      expect(body.connectedPeers).toBe(2);
      expect(body.agentCount).toBe(5);
      expect(body.activeRuns).toBe(3);
    });

    it('should return degraded when some peers disconnected but majority connected', async () => {
      deps.peerRegistry = mockPeerRegistry({
        peerCount: 3,
        connectedPeerCount: 2, // 2/3 connected, majority = 2
      });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/health');
      const body = await res.json();

      expect(body.status).toBe('degraded');
    });

    it('should return unhealthy when no leader', async () => {
      deps.raft = mockRaft({ role: 'follower', leaderId: null });
      deps.peerRegistry = mockPeerRegistry({
        peerCount: 2,
        connectedPeerCount: 2,
      });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/health');
      const body = await res.json();

      expect(body.status).toBe('unhealthy');
      expect(body.role).toBe('follower');
      expect(body.leaderId).toBeNull();
    });

    it('should return unhealthy when majority peers disconnected', async () => {
      deps.peerRegistry = mockPeerRegistry({
        peerCount: 3,
        connectedPeerCount: 1, // 1/3 connected, majority = 2
      });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/health');
      const body = await res.json();

      expect(body.status).toBe('unhealthy');
    });

    it('should return degraded in 3-node cluster with 1 peer lost (quorum preserved via self)', async () => {
      // 3-node cluster: self + 2 peers. 1 peer disconnected.
      // Connected nodes = self + 1 peer = 2. Majority of 3 = 2. Quorum holds → degraded, not unhealthy.
      deps.peerRegistry = mockPeerRegistry({
        peerCount: 2,
        connectedPeerCount: 1,
      });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/health');
      const body = await res.json();

      expect(body.status).toBe('degraded');
    });

    it('should return unhealthy in 3-node cluster with 2 peers lost (quorum lost)', async () => {
      // 3-node cluster: self + 2 peers. Both peers disconnected.
      // Connected nodes = self only = 1. Majority of 3 = 2. No quorum → unhealthy.
      deps.peerRegistry = mockPeerRegistry({
        peerCount: 2,
        connectedPeerCount: 0,
      });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/health');
      const body = await res.json();

      expect(body.status).toBe('unhealthy');
    });

    it('should return degraded in 5-node cluster with 2 peers lost (quorum preserved)', async () => {
      // 5-node cluster: self + 4 peers. 2 peers disconnected.
      // Connected nodes = self + 2 peers = 3. Majority of 5 = 3. Quorum holds → degraded.
      deps.peerRegistry = mockPeerRegistry({
        peerCount: 4,
        connectedPeerCount: 2,
      });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/health');
      const body = await res.json();

      expect(body.status).toBe('degraded');
    });

    it('should return healthy with zero peers (single-node cluster)', async () => {
      deps.peerRegistry = mockPeerRegistry({
        peerCount: 0,
        connectedPeerCount: 0,
      });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/health');
      const body = await res.json();

      expect(body.status).toBe('healthy');
      expect(body.peerCount).toBe(0);
      expect(body.connectedPeers).toBe(0);
    });

    it('should reflect candidate role during election', async () => {
      deps.raft = mockRaft({ role: 'candidate', leaderId: null });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/health');
      const body = await res.json();

      expect(body.role).toBe('candidate');
      expect(body.status).toBe('unhealthy'); // No leader during election
    });
  });

  // ── GET /cluster/peers ───────────────────────────────────────

  describe('GET /cluster/peers', () => {
    it('should return peer list from PeerRegistry', async () => {
      const peers = [
        createPeer({
          instanceId: 'peer-1',
          connectionId: 'conn-1',
          address: 'ws://10.0.0.1:4000',
          connected: true,
          lastHeartbeatAt: 1708286400000,
          agents: [
            {
              agentId: 'agent-1',
              labels: ['linux', 'x64'],
              activeJobs: 1,
              maxConcurrency: 3,
              platform: 'linux',
              arch: 'x64',
            },
            {
              agentId: 'agent-2',
              labels: ['linux', 'arm64'],
              activeJobs: 0,
              maxConcurrency: 2,
              platform: 'linux',
              arch: 'arm64',
            },
          ],
          draining: false,
          capabilities: { s3LogAccess: true },
          role: 'coordinator',
        }),
        createPeer({
          instanceId: 'peer-2',
          connectionId: 'conn-2',
          address: 'ws://10.0.0.2:4000',
          connected: false,
          lastHeartbeatAt: 1708286300000,
          agents: [],
          draining: true,
          capabilities: { s3LogAccess: false },
          role: 'worker',
        }),
      ];

      deps.peerRegistry = mockPeerRegistry({ peers });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/peers');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.peers).toHaveLength(2);

      expect(body.peers[0].instanceId).toBe('peer-1');
      expect(body.peers[0].connected).toBe(true);
      expect(body.peers[0].agentCount).toBe(2);
      expect(body.peers[0].draining).toBe(false);
      expect(body.peers[0].capabilities).toEqual({ s3LogAccess: true });
      expect(body.peers[0].lastHeartbeat).toBe(1708286400000);
      expect(body.peers[0].role).toBe('coordinator');

      expect(body.peers[1].instanceId).toBe('peer-2');
      expect(body.peers[1].connected).toBe(false);
      expect(body.peers[1].agentCount).toBe(0);
      expect(body.peers[1].draining).toBe(true);
      expect(body.peers[1].role).toBe('worker');
    });

    it('should return empty array when no peers', async () => {
      deps.peerRegistry = mockPeerRegistry({ peers: [] });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/peers');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.peers).toEqual([]);
    });
  });

  // ── GET /cluster/runs ────────────────────────────────────────

  describe('GET /cluster/runs', () => {
    it('should return active runs from ExecutionTracker', async () => {
      const activeRuns = [
        {
          runId: 'run-1',
          workflowName: 'ci',
          status: 'running',
          jobs: { total: 4, completed: 1, failed: 0, running: 3 },
        },
        {
          runId: 'run-2',
          workflowName: 'deploy',
          status: 'running',
          jobs: { total: 2, completed: 0, failed: 0, running: 2 },
        },
      ];

      deps.executionTracker = mockExecutionTracker({ activeRuns });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/runs');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.activeRuns).toHaveLength(2);
      expect(body.activeRuns[0].runId).toBe('run-1');
      expect(body.activeRuns[0].workflowName).toBe('ci');
      expect(body.activeRuns[0].jobs.total).toBe(4);
      expect(body.activeRuns[0].jobs.completed).toBe(1);
      expect(body.activeRuns[0].jobs.running).toBe(3);
    });

    it('should return empty array when no active runs', async () => {
      deps.executionTracker = mockExecutionTracker({ activeRuns: [] });

      const app = createClusterHealthRoutes(deps);
      const res = await app.request('/cluster/runs');
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.activeRuns).toEqual([]);
    });
  });
});
