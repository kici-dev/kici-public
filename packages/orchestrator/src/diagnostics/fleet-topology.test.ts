import { describe, it, expect } from 'vitest';
import { buildFleetTopology } from './fleet-topology.js';

describe('buildFleetTopology', () => {
  it('links a coordinator with 2 agents and a worker (with its own agent)', () => {
    const topo = buildFleetTopology({
      instanceId: 'coord-a',
      role: 'coordinator',
      hostname: 'host-a',
      listLocalAgents: () => [
        { agentId: 'a1', labels: ['linux', 'env=prod'] },
        { agentId: 'a2', labels: ['docker'] },
      ],
      listPeers: () => [
        {
          instanceId: 'worker-1',
          role: 'worker',
          hostname: 'host-w',
          agents: [{ agentId: 'wa1', labels: ['arm64'] }],
        },
      ],
    });

    const root = topo.nodes.find((n) => n.id === 'coord-a');
    expect(root).toMatchObject({ kind: 'orchestrator', role: 'coordinator', parentId: null });

    // Root's agents are parented to the root.
    expect(topo.nodes.find((n) => n.id === 'a1')).toMatchObject({
      kind: 'agent',
      parentId: 'coord-a',
      labels: { linux: '', env: 'prod' },
    });
    expect(topo.nodes.find((n) => n.id === 'a2')?.parentId).toBe('coord-a');

    // The worker peer is parented to the root; its agent is parented to the worker.
    expect(topo.nodes.find((n) => n.id === 'worker-1')).toMatchObject({
      kind: 'orchestrator',
      role: 'worker',
      parentId: 'coord-a',
    });
    expect(topo.nodes.find((n) => n.id === 'wa1')).toMatchObject({
      kind: 'agent',
      parentId: 'worker-1',
      labels: { arm64: '' },
    });
  });

  it('collapses to a single orchestrator node when sourceless / no agents / no peers', () => {
    const topo = buildFleetTopology({
      instanceId: 'solo',
      role: 'coordinator',
      listLocalAgents: () => [],
      listPeers: () => [],
    });
    expect(topo.nodes).toHaveLength(1);
    expect(topo.nodes[0]).toMatchObject({ id: 'solo', kind: 'orchestrator', parentId: null });
  });
});
