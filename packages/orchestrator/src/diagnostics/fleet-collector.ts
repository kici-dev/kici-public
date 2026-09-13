/**
 * Recursive fleet subtree assembler.
 *
 * Every orchestrator runs this to produce a self-similar subtree ZIP:
 * local/ + nested agents/<id>.zip + workers/<id>.zip + peers/<id>.zip, plus
 * fleet-manifest.json recording per-node status. Dead branches are recorded,
 * never fatal (Promise.allSettled at each level). The loop guard
 * (includeCoordinatorMesh) is true only on the root call; every downstream peer
 * request sets it false so the coordinator mesh never echoes.
 */
import { z } from 'zod';
import { ZipArchive } from 'archiver';

/** Per-node collection outcome recorded in the fleet manifest. */
export const FleetNodeStatus = z.enum(['ok', 'timeout', 'error', 'unreachable']);
export type FleetNodeStatus = z.infer<typeof FleetNodeStatus>;

export interface FleetCollectorDeps {
  /** This orchestrator's instanceId (the manifest owner). */
  instanceId: string;
  /** Build this node's own debug bundle as a Buffer (createDebugBundle output). */
  buildLocalBundle: () => Promise<Buffer>;
  /** List this node's directly-connected agents. */
  listAgents: () => { agentId: string }[];
  /** Request a connected agent's mini-bundle over the agent WS channel. */
  requestAgentBundle: (agentId: string) => Promise<Buffer>;
  /** List this node's downstream peers (coordinator-mesh peers + its workers). */
  listPeers: () => {
    instanceId: string;
    role: 'coordinator' | 'worker';
    kind: 'peer' | 'worker';
  }[];
  /** Request a peer's subtree bundle over the peer WS channel (loop-guarded false). */
  requestPeerSubtree: (instanceId: string, includeCoordinatorMesh: boolean) => Promise<Buffer>;
}

export interface FleetCollectOptions {
  logWindowHours: number;
  selection: { all: boolean; agentIds: string[]; workerInstanceIds: string[] };
  /** Loop guard. True only on the root call; downstream requests force false. */
  includeCoordinatorMesh: boolean;
  timeoutMs: number;
}

interface ManifestNode {
  id: string;
  kind: string;
  status: FleetNodeStatus;
  error?: string;
  bytes?: number;
}

function classifyError(err: unknown): { status: FleetNodeStatus; error: string } {
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: /timed out/.test(message) ? FleetNodeStatus.enum.timeout : FleetNodeStatus.enum.error,
    error: message,
  };
}

export async function collectFleetSubtree(
  opts: FleetCollectOptions,
  deps: FleetCollectorDeps,
): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const out: Buffer[] = [];
  archive.on('data', (d: Buffer) => out.push(d));
  const done = new Promise<void>((res, rej) => {
    archive.on('end', res);
    archive.on('error', rej);
  });

  const nodes: ManifestNode[] = [];

  // local subtree bundle (this node's own createDebugBundle output)
  try {
    const local = await deps.buildLocalBundle();
    archive.append(local, { name: 'local/bundle.zip' });
    nodes.push({
      id: deps.instanceId,
      kind: 'local',
      status: FleetNodeStatus.enum.ok,
      bytes: local.length,
    });
  } catch (err) {
    nodes.push({ id: deps.instanceId, kind: 'local', ...classifyError(err) });
  }

  const wantAgent = (id: string): boolean =>
    opts.selection.all || opts.selection.agentIds.includes(id);
  const wantWorker = (id: string): boolean =>
    opts.selection.all || opts.selection.workerInstanceIds.includes(id);

  // agents — every selected, directly-connected agent
  await Promise.allSettled(
    deps
      .listAgents()
      .filter((a) => wantAgent(a.agentId))
      .map(async (a) => {
        try {
          const buf = await deps.requestAgentBundle(a.agentId);
          archive.append(buf, { name: `agents/${a.agentId}.zip` });
          nodes.push({
            id: a.agentId,
            kind: 'agent',
            status: FleetNodeStatus.enum.ok,
            bytes: buf.length,
          });
        } catch (err) {
          nodes.push({ id: a.agentId, kind: 'agent', ...classifyError(err) });
        }
      }),
  );

  // peers + workers. Coordinator-mesh peers are traversed only when the loop
  // guard is open (root call); workers are always traversed when selected.
  // Every downstream request forces includeCoordinatorMesh=false.
  const peers = deps
    .listPeers()
    .filter((p) => (p.kind === 'worker' ? wantWorker(p.instanceId) : opts.includeCoordinatorMesh));
  await Promise.allSettled(
    peers.map(async (p) => {
      const dir = p.kind === 'worker' ? 'workers' : 'peers';
      try {
        const buf = await deps.requestPeerSubtree(p.instanceId, false);
        archive.append(buf, { name: `${dir}/${p.instanceId}.zip` });
        nodes.push({
          id: p.instanceId,
          kind: p.kind,
          status: FleetNodeStatus.enum.ok,
          bytes: buf.length,
        });
      } catch (err) {
        nodes.push({ id: p.instanceId, kind: p.kind, ...classifyError(err) });
      }
    }),
  );

  archive.append(
    JSON.stringify(
      { instanceId: deps.instanceId, generatedAt: new Date().toISOString(), nodes },
      null,
      2,
    ),
    { name: 'fleet-manifest.json' },
  );
  await archive.finalize();
  await done;
  return Buffer.concat(out);
}
