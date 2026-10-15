/**
 * Recursive fleet subtree assembler. Every orchestrator produces a self-similar ZIP: local/,
 * nested agents/<id>.zip, workers/<id>.zip and peers/<id>.zip, plus fleet-manifest.json with
 * per-node status. Dead branches are recorded, never fatal (Promise.allSettled per level).
 * The loop guard (includeCoordinatorMesh) is true only on the root call, so the coordinator
 * mesh never echoes.
 */
import { z } from 'zod';
import { ZipArchive } from 'archiver';

/** Per-node collection outcome recorded in the fleet manifest. */
export const FleetNodeStatus = z.enum(['ok', 'timeout', 'error', 'unreachable']);
export type FleetNodeStatus = z.infer<typeof FleetNodeStatus>;

export interface FleetCollectorDeps {
  /** The manifest owner. */
  instanceId: string;
  /** createDebugBundle output. */
  buildLocalBundle: () => Promise<Buffer>;
  /** Directly-connected agents only. */
  listAgents: () => { agentId: string }[];
  /** Over the agent WS channel. */
  requestAgentBundle: (agentId: string) => Promise<Buffer>;
  /** Coordinator-mesh peers plus this node's workers. */
  listPeers: () => {
    instanceId: string;
    role: 'coordinator' | 'worker';
    kind: 'peer' | 'worker';
  }[];
  /** Over the peer WS channel; callers pass includeCoordinatorMesh=false. */
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

  // Mesh peers only when the loop guard is open (root call); selected workers always. Every
  // downstream request forces includeCoordinatorMesh=false.
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
