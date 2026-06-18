import { hostname } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import {
  handleDiagnosticsRequest,
  handleScalerAgentsRequest,
  buildSafeScalerConfig,
  type DiagnosticsHandlerDeps,
} from './dashboard-diagnostics-handler.js';
import { AgentRegistry } from '../agent/registry.js';
import { PeerRegistry } from '../cluster/peer-registry.js';
import type { AppConfig } from '../config.js';
import type { WsLike, PeerHeartbeat } from '@kici-dev/engine';
import type { ScalerManager } from '../scaler/manager.js';
import type { ScalerConfig, ScalerEntry } from '../scaler/types.js';

function createMockWs(): WsLike {
  return { send: vi.fn(), close: vi.fn() };
}

function createBaseDeps(overrides?: Partial<DiagnosticsHandlerDeps>): DiagnosticsHandlerDeps {
  return {
    agentRegistry: new AgentRegistry(),
    config: { mode: 'platform', instanceId: 'orch-test-001' } as AppConfig,
    version: '1.2.3',
    scalerBackends: ['container'],
    ...overrides,
  };
}

describe('handleDiagnosticsRequest', () => {
  it('returns empty agents array when no agents registered', async () => {
    const deps = createBaseDeps();
    const result = await handleDiagnosticsRequest(deps, 'req-1');

    expect(result.type).toBe('dashboard.diagnostics.response');
    expect(result.requestId).toBe('req-1');
    expect(result.agents).toEqual([]);
    expect(result.orchestrator.runningJobs).toBe(0);
    expect(result.orchestrator.queuedJobs).toBe(0);
    expect(result.orchestrator.version).toBe('1.2.3');
    expect(result.orchestrator.mode).toBe('platform');
    expect(result.orchestrator.scalerBackends).toEqual(['container']);
    expect(result.orchestrator.pendingLabelGaps).toEqual([]);
  });

  it('returns correct agent metadata for multiple agents', async () => {
    const registry = new AgentRegistry();
    registry.register('agent-1', createMockWs(), ['linux', 'docker'], 'linux', 'x64', '1.0.0');
    registry.register('agent-2', createMockWs(), ['linux', 'gpu'], 'linux', 'arm64', '1.0.1');

    const deps = createBaseDeps({ agentRegistry: registry });
    const result = await handleDiagnosticsRequest(deps, 'req-2', true);

    expect(result.agents).toHaveLength(2);

    const a1 = result.agents.find((a) => a.agentId === 'agent-1')!;
    expect(a1.labels).toEqual(expect.arrayContaining(['linux', 'docker']));
    expect(a1.platform).toBe('linux');
    expect(a1.arch).toBe('x64');
    expect(a1.version).toBe('1.0.0');
    expect(a1.registeredAt).toBeGreaterThan(0);

    const a2 = result.agents.find((a) => a.agentId === 'agent-2')!;
    expect(a2.labels).toEqual(expect.arrayContaining(['linux', 'gpu']));
    expect(a2.arch).toBe('arm64');
    expect(a2.version).toBe('1.0.1');
  });

  it('computes runningJobs as sum of all agent activeJobs', async () => {
    const registry = new AgentRegistry();
    registry.register('agent-1', createMockWs(), ['linux'], 'linux', 'x64', undefined, 4);
    registry.register('agent-2', createMockWs(), ['linux'], 'linux', 'x64', undefined, 2);
    registry.incrementActiveJobs('agent-1');
    registry.incrementActiveJobs('agent-1');
    registry.incrementActiveJobs('agent-2');

    const deps = createBaseDeps({ agentRegistry: registry });
    const result = await handleDiagnosticsRequest(deps, 'req-3');

    expect(result.orchestrator.runningJobs).toBe(3);
  });

  it('extracts mode and scaler backends from config', async () => {
    const deps = createBaseDeps({
      config: { mode: 'hybrid', instanceId: 'orch-hybrid' } as AppConfig,
      scalerBackends: ['container', 'firecracker'],
    });

    const result = await handleDiagnosticsRequest(deps, 'req-4');

    expect(result.orchestrator.mode).toBe('hybrid');
    expect(result.orchestrator.scalerBackends).toEqual(['container', 'firecracker']);
  });

  it('uses jobQueue.getDepth() for queuedJobs when available', async () => {
    const deps = createBaseDeps({
      jobQueue: { getDepth: async () => 7 },
    });

    const result = await handleDiagnosticsRequest(deps, 'req-5');

    expect(result.orchestrator.queuedJobs).toBe(7);
  });

  it('returns queuedJobs=0 when jobQueue is not provided', async () => {
    const deps = createBaseDeps({ jobQueue: undefined });

    const result = await handleDiagnosticsRequest(deps, 'req-6');

    expect(result.orchestrator.queuedJobs).toBe(0);
  });

  it('handles jobQueue.getDepth() failure gracefully', async () => {
    const deps = createBaseDeps({
      jobQueue: {
        getDepth: async () => {
          throw new Error('DB connection failed');
        },
      },
    });

    const result = await handleDiagnosticsRequest(deps, 'req-7');

    expect(result.orchestrator.queuedJobs).toBe(0);
  });

  it('returns null version for agents that did not report version', async () => {
    const registry = new AgentRegistry();
    registry.register('agent-no-ver', createMockWs(), ['linux'], 'linux', 'x64');

    const deps = createBaseDeps({ agentRegistry: registry });
    const result = await handleDiagnosticsRequest(deps, 'req-8', true);

    expect(result.agents[0].version).toBeNull();
  });

  // --- New metadata and scaler tests ---

  it('includes orchestrator instanceId in response', async () => {
    const deps = createBaseDeps({
      config: { mode: 'platform', instanceId: 'orch-prod-42' } as AppConfig,
    });
    const result = await handleDiagnosticsRequest(deps, 'req-id-1');

    expect(result.orchestrator.instanceId).toBe('orch-prod-42');
  });

  it('includes orchestrator OS metadata in response', async () => {
    const deps = createBaseDeps();
    const result = await handleDiagnosticsRequest(deps, 'req-os-1');

    expect(result.orchestrator.hostname).toBeDefined();
    expect(typeof result.orchestrator.hostname).toBe('string');
    expect(result.orchestrator.totalMemoryMb).toBeGreaterThan(0);
    expect(result.orchestrator.cpuCount).toBeGreaterThan(0);
    expect(result.orchestrator.nodeVersion).toBeDefined();
    expect(result.orchestrator.memoryUsedMb).toBeGreaterThan(0);
    expect(result.orchestrator.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('includes scalers array with safe config when scalerConfig provided', async () => {
    const mockScalerManager = {
      getStatus: () => ({
        globalMaxAgents: 10,
        globalActiveCount: 2,
        spawningCount: 0,
        warmPoolCount: 0,
        backends: [
          {
            name: 'docker-pool',
            type: 'container',
            activeCount: 2,
            maxAgents: 5,
            labelSets: [['linux', 'x64']],
          },
        ],
      }),
      getBackendForAgent: () => null,
    } as unknown as ScalerManager;

    const scalerConfig: ScalerConfig = {
      version: 1,
      globalMaxAgents: 10,
      scalers: [
        {
          name: 'docker-pool',
          type: 'container',
          maxAgents: 5,
          labelSets: [{ labels: ['linux', 'x64'] }],
          runtime: 'podman',
          host: 'unix:///run/podman/podman.sock',
          socketPath: '/run/podman/podman.sock',
          orchestratorUrl: 'ws://localhost:4000',
          extraHosts: ['verdaccio.local:host-gateway'],
          networkIsolation: true,
        },
      ],
    };

    const deps = createBaseDeps({
      scalerManager: mockScalerManager,
      scalerConfig,
    });
    const result = await handleDiagnosticsRequest(deps, 'req-scaler-1');

    expect(result.scalers).toBeDefined();
    expect(result.scalers).toHaveLength(1);
    const scaler = result.scalers![0];
    expect(scaler.name).toBe('docker-pool');
    expect(scaler.type).toBe('container');
    expect(scaler.maxAgents).toBe(5);
    expect(scaler.activeAgents).toBe(2);
    expect(scaler.labelSets).toEqual([['linux', 'x64']]);
    expect(scaler.config).toBeDefined();
  });

  it('statically surfaces the spawning host on local-spawn scalers, omits for remote backends', async () => {
    const registry = new AgentRegistry();
    // Stateful (unbound) agent — its host is still aggregated from its label.
    registry.register('sf-1', createMockWs(), ['kici:host:macbook.local'], 'darwin', 'arm64');

    const mockScalerManager = {
      getStatus: () => ({
        globalMaxAgents: 10,
        globalActiveCount: 0,
        spawningCount: 0,
        warmPoolCount: 0,
        backends: [
          {
            name: 'bm-pool',
            type: 'bare-metal',
            activeCount: 0,
            maxAgents: 4,
            labelSets: [['linux']],
            spawnsOnLocalHost: true,
          },
          {
            name: 'ctr-pool',
            type: 'container',
            activeCount: 0,
            maxAgents: 4,
            labelSets: [['linux']],
            spawnsOnLocalHost: true,
          },
          {
            name: 'remote-pool',
            type: 'container',
            activeCount: 0,
            maxAgents: 4,
            labelSets: [['linux']],
            spawnsOnLocalHost: false,
          },
        ],
      }),
      getBackendForAgent: () => null,
    } as unknown as ScalerManager;

    const scalerConfig: ScalerConfig = {
      version: 1,
      globalMaxAgents: 10,
      scalers: [
        { name: 'bm-pool', type: 'bare-metal', maxAgents: 4, labelSets: [{ labels: ['linux'] }] },
        { name: 'ctr-pool', type: 'container', maxAgents: 4, labelSets: [{ labels: ['linux'] }] },
        {
          name: 'remote-pool',
          type: 'container',
          maxAgents: 4,
          labelSets: [{ labels: ['linux'] }],
        },
      ],
    };

    const deps = createBaseDeps({
      agentRegistry: registry,
      scalerManager: mockScalerManager,
      scalerConfig,
    });
    const result = await handleDiagnosticsRequest(deps, 'req-hosts');

    // Local-spawn scalers carry the orchestrator's own hostname even with zero
    // live agents (the host is knowable statically).
    const bm = result.scalers!.find((s) => s.name === 'bm-pool')!;
    expect(bm.hosts).toEqual([hostname()]);
    const ctr = result.scalers!.find((s) => s.name === 'ctr-pool')!;
    expect(ctr.hosts).toEqual([hostname()]);
    // A container scaler on a remote runtime does not spawn here — no host.
    const remote = result.scalers!.find((s) => s.name === 'remote-pool')!;
    expect(remote.hosts).toBeUndefined();
  });

  it('sets scalerName for managed agents and null for standalone', async () => {
    const registry = new AgentRegistry();
    registry.register('managed-1', createMockWs(), ['linux'], 'linux', 'x64');
    registry.register('standalone-1', createMockWs(), ['linux'], 'linux', 'x64');

    const mockScalerManager = {
      getStatus: () => ({
        globalMaxAgents: 10,
        globalActiveCount: 1,
        spawningCount: 0,
        warmPoolCount: 0,
        backends: [],
      }),
      getBackendForAgent: (agentId: string) => (agentId === 'managed-1' ? 'docker-pool' : null),
    } as unknown as ScalerManager;

    const deps = createBaseDeps({
      agentRegistry: registry,
      scalerManager: mockScalerManager,
    });
    const result = await handleDiagnosticsRequest(deps, 'req-scaler-name-1', true);

    const managed = result.agents.find((a) => a.agentId === 'managed-1')!;
    const standalone = result.agents.find((a) => a.agentId === 'standalone-1')!;
    expect(managed.scalerName).toBe('docker-pool');
    expect(standalone.scalerName).toBeNull();
  });

  it('includes agent metadata fields from registration', async () => {
    const registry = new AgentRegistry();
    registry.register('agent-meta', createMockWs(), ['linux'], 'linux', 'x64', '2.0.0', 1, {
      hostname: 'worker-42',
      osRelease: '6.1.0',
      osVersion: '#1 SMP',
      totalMemoryMb: 16384,
      cpuCount: 8,
      nodeVersion: '24.0.0',
    });

    const deps = createBaseDeps({ agentRegistry: registry });
    const result = await handleDiagnosticsRequest(deps, 'req-meta-1', true);

    const agent = result.agents[0];
    expect(agent.hostname).toBe('worker-42');
    expect(agent.osRelease).toBe('6.1.0');
    expect(agent.totalMemoryMb).toBe(16384);
    expect(agent.cpuCount).toBe(8);
    expect(agent.nodeVersion).toBe('24.0.0');
  });

  it('includes runningAsUser and runningAsUid from os.userInfo()', async () => {
    const deps = createBaseDeps();
    const result = await handleDiagnosticsRequest(deps, 'req-user-1');

    // Should be populated with current process user info
    expect(typeof result.orchestrator.runningAsUser).toBe('string');
    expect(result.orchestrator.runningAsUser!.length).toBeGreaterThan(0);
    expect(typeof result.orchestrator.runningAsUid).toBe('number');
  });

  it('returns no scalers when scalerConfig not provided', async () => {
    const deps = createBaseDeps();
    const result = await handleDiagnosticsRequest(deps, 'req-no-scaler');

    expect(result.scalers).toBeUndefined();
  });

  // --- Peers tests ---

  it('returns undefined peers when peerRegistry is not provided', async () => {
    const deps = createBaseDeps();
    const result = await handleDiagnosticsRequest(deps, 'req-no-peers');

    expect(result.peers).toBeUndefined();
  });

  it('returns empty peers array when peerRegistry has no workers', async () => {
    const peerRegistry = new PeerRegistry();
    const deps = createBaseDeps({ peerRegistry });
    const result = await handleDiagnosticsRequest(deps, 'req-empty-peers');

    expect(result.peers).toEqual([]);
  });

  it('includes only connected worker peers, excludes coordinator peers', async () => {
    const peerRegistry = new PeerRegistry();
    peerRegistry.addPeer({
      instanceId: 'worker-1',
      connectionId: 'conn-w1',
      address: 'http://worker-1:4000',
      routingKeys: [],
      role: 'worker',
    });
    peerRegistry.addPeer({
      instanceId: 'coord-1',
      connectionId: 'conn-c1',
      address: 'http://coord-1:4000',
      routingKeys: [],
      role: 'coordinator',
    });

    const deps = createBaseDeps({ peerRegistry });
    const result = await handleDiagnosticsRequest(deps, 'req-filter-peers');

    expect(result.peers).toHaveLength(1);
    expect(result.peers![0].instanceId).toBe('worker-1');
    expect(result.peers![0].role).toBe('worker');
  });

  it('excludes disconnected worker peers', async () => {
    const peerRegistry = new PeerRegistry();
    peerRegistry.addPeer({
      instanceId: 'worker-alive',
      connectionId: 'conn-a',
      address: 'http://alive:4000',
      routingKeys: [],
      role: 'worker',
    });
    peerRegistry.addPeer({
      instanceId: 'worker-dead',
      connectionId: 'conn-d',
      address: 'http://dead:4000',
      routingKeys: [],
      role: 'worker',
    });
    peerRegistry.markDisconnected('worker-dead');

    const deps = createBaseDeps({ peerRegistry });
    const result = await handleDiagnosticsRequest(deps, 'req-disconnected');

    expect(result.peers).toHaveLength(1);
    expect(result.peers![0].instanceId).toBe('worker-alive');
  });

  it('maps peer agent data correctly', async () => {
    const peerRegistry = new PeerRegistry();
    peerRegistry.addPeer({
      instanceId: 'worker-agents',
      connectionId: 'conn-wa',
      address: 'http://worker:4000',
      routingKeys: [],
      role: 'worker',
    });
    peerRegistry.updateHeartbeat('worker-agents', {
      type: 'peer.heartbeat',
      instanceId: 'worker-agents',
      timestamp: Date.now(),
      agents: [
        {
          agentId: 'agent-1',
          labels: ['linux', 'docker'],
          activeJobs: 2,
          maxConcurrency: 4,
          platform: 'linux',
          arch: 'x64',
        },
      ],
      draining: false,
      capabilities: { s3LogAccess: true },
      term: 1,
      leaderId: 'coord-1',
    } as PeerHeartbeat);

    const deps = createBaseDeps({ peerRegistry });
    const result = await handleDiagnosticsRequest(deps, 'req-agents');

    expect(result.peers).toHaveLength(1);
    const peer = result.peers![0];
    expect(peer.agents).toHaveLength(1);
    expect(peer.agents[0].agentId).toBe('agent-1');
    expect(peer.agents[0].labels).toEqual(['linux', 'docker']);
    expect(peer.agents[0].platform).toBe('linux');
    expect(peer.agents[0].arch).toBe('x64');
    expect(peer.agents[0].activeJobs).toBe(2);
    expect(peer.agents[0].maxConcurrency).toBe(4);
  });

  it('includes scalerCapacity when present in peer data', async () => {
    const peerRegistry = new PeerRegistry();
    peerRegistry.addPeer({
      instanceId: 'worker-scaler',
      connectionId: 'conn-ws',
      address: 'http://worker:4000',
      routingKeys: [],
      role: 'worker',
    });
    peerRegistry.updateHeartbeat('worker-scaler', {
      type: 'peer.heartbeat',
      instanceId: 'worker-scaler',
      timestamp: Date.now(),
      agents: [],
      draining: false,
      capabilities: { s3LogAccess: false },
      term: 1,
      leaderId: 'coord-1',
      scalerCapacity: [
        {
          name: 'docker-pool',
          type: 'container',
          activeCount: 1,
          maxAgents: 5,
          labelSets: [['linux', 'x64']],
        },
      ],
    } as PeerHeartbeat);

    const deps = createBaseDeps({ peerRegistry });
    const result = await handleDiagnosticsRequest(deps, 'req-scaler-cap');

    expect(result.peers).toHaveLength(1);
    expect(result.peers![0].scalerCapacity).toHaveLength(1);
    expect(result.peers![0].scalerCapacity![0].name).toBe('docker-pool');
    expect(result.peers![0].scalerCapacity![0].activeCount).toBe(1);
  });

  it('includes Raft state when raftNode is provided', async () => {
    const mockRaftNode = {
      getRole: () => 'leader' as const,
      getCurrentTerm: () => 5,
      getLeaderId: () => 'orch-test-001',
    };

    const deps = createBaseDeps({ raftNode: mockRaftNode as any });
    const result = await handleDiagnosticsRequest(deps, 'req-raft-1');

    expect(result.orchestrator.raftRole).toBe('leader');
    expect(result.orchestrator.raftTerm).toBe(5);
    expect(result.orchestrator.raftLeaderId).toBe('orch-test-001');
  });

  it('returns null Raft fields when raftNode is not provided', async () => {
    const deps = createBaseDeps();
    const result = await handleDiagnosticsRequest(deps, 'req-raft-2');

    expect(result.orchestrator.raftRole).toBeNull();
    expect(result.orchestrator.raftTerm).toBeNull();
    expect(result.orchestrator.raftLeaderId).toBeNull();
  });

  it('includes Raft term and leader in peer entries', async () => {
    const peerRegistry = new PeerRegistry();
    peerRegistry.addPeer({
      instanceId: 'worker-raft',
      connectionId: 'conn-raft',
      address: 'http://worker:4000',
      routingKeys: [],
      role: 'worker',
    });
    // Simulate a heartbeat that sets term and leaderId
    const heartbeat: PeerHeartbeat = {
      type: 'peer.heartbeat',
      instanceId: 'worker-raft',
      term: 3,
      leaderId: 'orch-test-001',
      draining: false,
      agents: [],
      capabilities: {},
      timestamp: Date.now(),
    };
    peerRegistry.updateHeartbeat('worker-raft', heartbeat);

    const deps = createBaseDeps({ peerRegistry });
    const result = await handleDiagnosticsRequest(deps, 'req-raft-3');

    expect(result.peers).toHaveLength(1);
    expect(result.peers![0].raftTerm).toBe(3);
    expect(result.peers![0].raftLeaderId).toBe('orch-test-001');
  });

  it('returns undefined dependencyHealth when not present in peer data', async () => {
    const peerRegistry = new PeerRegistry();
    peerRegistry.addPeer({
      instanceId: 'worker-no-health',
      connectionId: 'conn-nh',
      address: 'http://worker:4000',
      routingKeys: [],
      role: 'worker',
    });

    const deps = createBaseDeps({ peerRegistry });
    const result = await handleDiagnosticsRequest(deps, 'req-no-health');

    expect(result.peers).toHaveLength(1);
    expect(result.peers![0].dependencyHealth).toBeUndefined();
  });

  // --- includeAgents flag tests ---

  it('returns empty agents and populated aggregates when includeAgents is false', async () => {
    const registry = new AgentRegistry();
    registry.register('agent-a', createMockWs(), ['linux'], 'linux', 'x64', '1.2.3');
    registry.register('agent-b', createMockWs(), ['linux'], 'linux', 'x64', '9.9.9');

    const mockScalerManager = {
      getStatus: () => ({
        globalMaxAgents: 10,
        globalActiveCount: 1,
        spawningCount: 0,
        warmPoolCount: 0,
        backends: [],
      }),
      getBackendForAgent: (agentId: string) => (agentId === 'agent-a' ? 'docker-pool' : null),
    } as unknown as ScalerManager;

    const deps = createBaseDeps({ agentRegistry: registry, scalerManager: mockScalerManager });
    const result = await handleDiagnosticsRequest(deps, 'req-no-agents', false);

    expect(result.agents).toEqual([]);
    expect(result.orchestrator.agentCount).toBe(2);
    expect(result.orchestrator.statefulAgentCount).toBe(1);
  });

  it('populates aggregates even when includeAgents is true', async () => {
    const registry = new AgentRegistry();
    registry.register('agent-c', createMockWs(), ['linux'], 'linux', 'x64', '1.2.3');

    const deps = createBaseDeps({ agentRegistry: registry });
    const result = await handleDiagnosticsRequest(deps, 'req-agg-with-agents', true);

    expect(result.agents).toHaveLength(1);
    expect(result.orchestrator.agentCount).toBe(1);
    expect(result.orchestrator.statefulAgentCount).toBe(1);
  });
});

describe('handleScalerAgentsRequest', () => {
  it('returns agents for a named scaler', () => {
    const registry = new AgentRegistry();
    registry.register('managed-1', createMockWs(), ['linux'], 'linux', 'x64', '1.0.0');
    registry.register('standalone-1', createMockWs(), ['linux'], 'linux', 'x64', '1.0.0');

    const mockScalerManager = {
      getStatus: () => ({
        globalMaxAgents: 10,
        globalActiveCount: 1,
        spawningCount: 0,
        warmPoolCount: 0,
        backends: [],
      }),
      getBackendForAgent: (agentId: string) => (agentId === 'managed-1' ? 'docker-pool' : null),
    } as unknown as ScalerManager;

    const deps = createBaseDeps({ agentRegistry: registry, scalerManager: mockScalerManager });
    const result = handleScalerAgentsRequest(deps, 'req-sa-1', 'docker-pool');

    expect(result.type).toBe('dashboard.scaler.agents.response');
    expect(result.scalerName).toBe('docker-pool');
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].agentId).toBe('managed-1');
  });

  it('returns stateful agents when scalerName is null', () => {
    const registry = new AgentRegistry();
    registry.register('managed-1', createMockWs(), ['linux'], 'linux', 'x64', '1.0.0');
    registry.register('standalone-1', createMockWs(), ['linux'], 'linux', 'x64', '1.0.0');

    const mockScalerManager = {
      getStatus: () => ({
        globalMaxAgents: 10,
        globalActiveCount: 1,
        spawningCount: 0,
        warmPoolCount: 0,
        backends: [],
      }),
      getBackendForAgent: (agentId: string) => (agentId === 'managed-1' ? 'docker-pool' : null),
    } as unknown as ScalerManager;

    const deps = createBaseDeps({ agentRegistry: registry, scalerManager: mockScalerManager });
    const result = handleScalerAgentsRequest(deps, 'req-sa-2', null);

    expect(result.type).toBe('dashboard.scaler.agents.response');
    expect(result.scalerName).toBeNull();
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].agentId).toBe('standalone-1');
  });

  it('returns empty agents when no agents match the scaler', () => {
    const registry = new AgentRegistry();
    registry.register('agent-1', createMockWs(), ['linux'], 'linux', 'x64', '1.0.0');

    const deps = createBaseDeps({ agentRegistry: registry });
    const result = handleScalerAgentsRequest(deps, 'req-sa-3', 'nonexistent');

    expect(result.agents).toEqual([]);
  });
});

describe('buildSafeScalerConfig', () => {
  it('includes only allowlisted fields', () => {
    const entry: ScalerEntry = {
      name: 'fc-pool',
      type: 'firecracker',
      maxAgents: 3,
      labelSets: [{ labels: ['linux', 'x64'] }],
      socketPath: '/var/run/secret.sock',
      firecrackerPath: '/usr/bin/firecracker',
      jailerPath: '/usr/bin/jailer',
      chrootBaseDir: '/srv/jailer',
      uid: 10000,
      gid: 10000,
      runtime: 'podman',
      host: 'tcp://host:2376',
      orchestratorUrl: 'ws://localhost:4000',
      extraHosts: ['verdaccio.local:host-gateway'],
      networkIsolation: true,
      warmPool: { enabled: true, size: 2, idleTimeoutSeconds: 300 },
    };

    const safe = buildSafeScalerConfig(entry);

    // Allowed fields present
    expect(safe.runtime).toBe('podman');
    expect(safe.host).toBe('tcp://host:2376');
    expect(safe.orchestratorUrl).toBe('ws://localhost:4000');
    expect(safe.extraHosts).toEqual(['verdaccio.local:host-gateway']);
    expect(safe.networkIsolation).toBe(true);
    expect(safe.warmPool).toEqual({ minIdle: 2, maxIdle: 2, enabled: true });
    expect(safe.labelSets).toEqual([['linux', 'x64']]);

    // Secret fields NOT present
    expect(safe).not.toHaveProperty('socketPath');
    expect(safe).not.toHaveProperty('firecrackerPath');
    expect(safe).not.toHaveProperty('jailerPath');
    expect(safe).not.toHaveProperty('chrootBaseDir');
    expect(safe).not.toHaveProperty('uid');
    expect(safe).not.toHaveProperty('gid');
  });

  it('returns null for missing optional fields', () => {
    const entry: ScalerEntry = {
      name: 'minimal',
      type: 'container',
      maxAgents: 1,
      labelSets: [],
    };

    const safe = buildSafeScalerConfig(entry);

    expect(safe.runtime).toBeNull();
    expect(safe.host).toBeNull();
    expect(safe.warmPool).toBeNull();
    expect(safe.networkIsolation).toBeNull();
    expect(safe.orchestratorUrl).toBeNull();
    expect(safe.extraHosts).toBeNull();
  });
});
