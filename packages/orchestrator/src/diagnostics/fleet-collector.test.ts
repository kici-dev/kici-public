import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { collectFleetSubtree, type FleetCollectorDeps } from './fleet-collector.js';

async function readManifest(buf: Buffer): Promise<{
  instanceId: string;
  nodes: { id: string; kind: string; status: string }[];
}> {
  const zip = await JSZip.loadAsync(buf);
  return JSON.parse(await zip.file('fleet-manifest.json')!.async('string'));
}

function baseDeps(overrides: Partial<FleetCollectorDeps> = {}): FleetCollectorDeps {
  return {
    instanceId: 'root',
    buildLocalBundle: vi.fn(async () => Buffer.from('PKlocal')),
    listAgents: () => [{ agentId: 'a1' }, { agentId: 'a2' }],
    requestAgentBundle: vi.fn(async (id: string) =>
      id === 'a1' ? Buffer.from('PKa1') : Promise.reject(new Error('timed out')),
    ),
    listPeers: () => [{ instanceId: 'p1', role: 'coordinator', kind: 'peer' }],
    requestPeerSubtree: vi.fn(async () => Buffer.from('PKp1')),
    ...overrides,
  };
}

describe('collectFleetSubtree', () => {
  it('assembles local + selected agents + peers into one zip with a manifest', async () => {
    const deps = baseDeps();
    const buf = await collectFleetSubtree(
      {
        logWindowHours: 4,
        selection: { all: true, agentIds: [], workerInstanceIds: [] },
        includeCoordinatorMesh: true,
        timeoutMs: 1000,
      },
      deps,
    );
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');

    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files);
    expect(names).toContain('local/bundle.zip');
    expect(names).toContain('agents/a1.zip');
    expect(names).toContain('peers/p1.zip');
    // a2 failed (rejected) so it has no nested zip.
    expect(names).not.toContain('agents/a2.zip');

    const manifest = await readManifest(buf);
    expect(manifest.instanceId).toBe('root');
    expect(manifest.nodes.find((n) => n.kind === 'local')?.status).toBe('ok');
    expect(manifest.nodes.find((n) => n.id === 'a1')?.status).toBe('ok');
    expect(manifest.nodes.find((n) => n.id === 'a2')?.status).toBe('timeout');
    expect(manifest.nodes.find((n) => n.id === 'p1')?.status).toBe('ok');
  });

  it('honors the loop guard: downstream peers are skipped when includeCoordinatorMesh is false', async () => {
    const requestPeerSubtree = vi.fn(async () => Buffer.from('PKp1'));
    const deps = baseDeps({ requestPeerSubtree });
    const buf = await collectFleetSubtree(
      {
        logWindowHours: 4,
        selection: { all: true, agentIds: [], workerInstanceIds: [] },
        includeCoordinatorMesh: false,
        timeoutMs: 1000,
      },
      deps,
    );
    const names = Object.keys((await JSZip.loadAsync(buf)).files);
    expect(names).not.toContain('peers/p1.zip');
    expect(requestPeerSubtree).not.toHaveBeenCalled();
  });

  it('prunes unselected agents', async () => {
    const requestAgentBundle = vi.fn(async () => Buffer.from('PKx'));
    const deps = baseDeps({ requestAgentBundle });
    const buf = await collectFleetSubtree(
      {
        logWindowHours: 4,
        selection: { all: false, agentIds: ['a1'], workerInstanceIds: [] },
        includeCoordinatorMesh: true,
        timeoutMs: 1000,
      },
      deps,
    );
    const names = Object.keys((await JSZip.loadAsync(buf)).files);
    expect(names).toContain('agents/a1.zip');
    expect(names).not.toContain('agents/a2.zip');
    expect(requestAgentBundle).toHaveBeenCalledTimes(1);
    expect(requestAgentBundle).toHaveBeenCalledWith('a1');
  });

  it('records workers under workers/ and downstream peer requests carry includeCoordinatorMesh=false', async () => {
    const requestPeerSubtree = vi.fn(async () => Buffer.from('PKw'));
    const deps = baseDeps({
      listPeers: () => [{ instanceId: 'w1', role: 'worker', kind: 'worker' }],
      requestPeerSubtree,
    });
    const buf = await collectFleetSubtree(
      {
        logWindowHours: 4,
        selection: { all: true, agentIds: [], workerInstanceIds: [] },
        includeCoordinatorMesh: true,
        timeoutMs: 1000,
      },
      deps,
    );
    const names = Object.keys((await JSZip.loadAsync(buf)).files);
    expect(names).toContain('workers/w1.zip');
    expect(requestPeerSubtree).toHaveBeenCalledWith('w1', false);
  });
});
