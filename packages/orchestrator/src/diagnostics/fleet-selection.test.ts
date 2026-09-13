import { describe, it, expect } from 'vitest';
import { resolveSelection } from './fleet-selection.js';
import type { FleetTopology } from './fleet-topology.js';

const topology: FleetTopology = {
  nodes: [
    {
      kind: 'orchestrator',
      id: 'coord-a',
      role: 'coordinator',
      hostname: 'host-a',
      labels: {},
      parentId: null,
    },
    { kind: 'agent', id: 'a1', labels: { env: 'prod' }, parentId: 'coord-a' },
    { kind: 'agent', id: 'a2', labels: { env: 'dev' }, parentId: 'coord-a' },
    {
      kind: 'orchestrator',
      id: 'worker-1',
      role: 'worker',
      hostname: 'host-w',
      labels: {},
      parentId: 'coord-a',
    },
    { kind: 'agent', id: 'wa1', labels: { env: 'prod' }, parentId: 'worker-1' },
  ],
};

describe('resolveSelection', () => {
  it('no selectors => every orchestrator gets all:true', () => {
    const map = resolveSelection(topology, []);
    expect(map.get('coord-a')).toEqual({ all: true, agentIds: [], workerInstanceIds: [] });
    expect(map.get('worker-1')).toEqual({ all: true, agentIds: [], workerInstanceIds: [] });
  });

  it('exact agentId selects only that agent on its parent branch and prunes others', () => {
    const map = resolveSelection(topology, ['wa1']);
    // worker-1 carries wa1; coord-a and its agents are pruned (no match).
    expect(map.get('worker-1')).toEqual({ all: false, agentIds: ['wa1'], workerInstanceIds: [] });
    expect(map.has('coord-a')).toBe(false);
  });

  it('label selector matches agents across branches', () => {
    const map = resolveSelection(topology, ['label:env=prod']);
    expect(map.get('coord-a')).toEqual({ all: false, agentIds: ['a1'], workerInstanceIds: [] });
    expect(map.get('worker-1')).toEqual({ all: false, agentIds: ['wa1'], workerInstanceIds: [] });
  });

  it('hostname glob on an orchestrator selects it wholesale', () => {
    const map = resolveSelection(topology, ['host-a']);
    expect(map.get('coord-a')).toEqual({ all: true, agentIds: [], workerInstanceIds: [] });
    expect(map.has('worker-1')).toBe(false);
  });

  it('selecting a worker instanceId records it on its parent coordinator', () => {
    const map = resolveSelection(topology, ['worker-1']);
    // worker-1 matches itself wholesale...
    expect(map.get('worker-1')).toEqual({ all: true, agentIds: [], workerInstanceIds: [] });
    // ...and coord-a records worker-1 in its workerInstanceIds so the root knows
    // to traverse it.
    expect(map.get('coord-a')).toEqual({
      all: false,
      agentIds: [],
      workerInstanceIds: ['worker-1'],
    });
  });
});
