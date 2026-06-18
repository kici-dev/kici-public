/**
 * Fleet log collection wiring.
 *
 * Builds the FleetCollectorDeps / FleetTopologyDeps from an orchestrator's live
 * runtime pieces (agent registry, peer registry, agent collector, peer clients,
 * peer handler) and provides the peer-side responder that assembles this node's
 * subtree on an inbound peer.logs.collect.request. Kept out of the giant
 * orchestrator-core wiring file.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chunkBuffer, toErrorMessage } from '@kici-dev/shared';
import type { PeerLogsCollectRequest, PeerToPeerMessage, FleetSelection } from '@kici-dev/engine';
import type { AgentRegistry } from '../agent/registry.js';
import type { PeerRegistry } from '../cluster/peer-registry.js';
import type { PeerClient } from '../cluster/peer-client.js';
import { createDebugBundle } from './bundle-writer.js';
import type { DiagnosticDeps } from './types.js';
import { collectFleetSubtree, type FleetCollectorDeps } from './fleet-collector.js';
import {
  buildFleetTopology,
  type FleetTopology,
  type FleetTopologyDeps,
} from './fleet-topology.js';
import { FLEET_MAX_LOG_BYTES } from './fleet-constants.js';

/** A peer-handler-like object exposing the dual-direction collect send. */
export interface FleetPeerHandlerLike {
  sendLogsCollectAndWait: (
    targetInstanceId: string,
    msg: PeerLogsCollectRequest,
    timeoutMs: number,
  ) => Promise<Buffer>;
}

/** A collector that issues a fleet.logs.request to an agent and awaits its bundle. */
export interface FleetAgentRequester {
  request: (requestId: string, agentId: string, send: () => void) => Promise<Buffer>;
}

export interface FleetRuntime {
  instanceId: string;
  role: 'coordinator' | 'worker';
  /** Loop window for log files (hours). */
  logWindowHours: number;
  /** Per-node deadline (ms). */
  timeoutMs: number;
  /** Local agent log directory (KICI_LOG_DIR), if configured. */
  logDir?: string;
  agentRegistry: AgentRegistry;
  peerRegistry: PeerRegistry;
  fleetAgentCollector: FleetAgentRequester;
  /** Outgoing peer clients, keyed by instanceId. */
  peerClients: Map<string, PeerClient>;
  /** Incoming peer-handler with the dual-direction collect send. */
  peerHandler: FleetPeerHandlerLike;
  /** Deps for the local createDebugBundle. */
  diagnosticDeps: DiagnosticDeps;
  /** Raw orchestrator config (redacted by createDebugBundle). */
  config: Record<string, unknown>;
  /** Cluster health endpoint for the local bundle's cluster/health.json. */
  clusterHealthUrl?: string;
}

/** Build this node's own debug bundle as a Buffer via a temp file. */
async function buildLocalBundleBuffer(runtime: FleetRuntime): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `kici-fleet-local-${runtime.instanceId}-${randomUUID()}.zip`);
  try {
    await createDebugBundle({
      outputPath: tmp,
      orchestratorId: runtime.instanceId,
      config: runtime.config,
      logDir: runtime.logDir,
      logWindow: runtime.logWindowHours,
      diagnosticDeps: runtime.diagnosticDeps,
      clusterHealthUrl: runtime.clusterHealthUrl,
    });
    return fs.readFileSync(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Send a fleet.logs.request to an agent over its WS and await the bundle. */
function requestAgentBundle(runtime: FleetRuntime, agentId: string): Promise<Buffer> {
  const requestId = randomUUID();
  return runtime.fleetAgentCollector.request(requestId, agentId, () => {
    const entry = runtime.agentRegistry.get(agentId);
    if (entry && entry.ws.readyState === 1) {
      entry.ws.send(
        JSON.stringify({
          type: 'fleet.logs.request',
          requestId,
          logWindowHours: runtime.logWindowHours,
          maxBytes: FLEET_MAX_LOG_BYTES,
        }),
      );
    }
  });
}

/**
 * Request a peer's subtree bundle, trying the outgoing PeerClient first, then
 * falling back to the incoming peer-handler connection (the same dual-direction
 * lookup forwardReloadToPeer uses — a peer pair shares one WS).
 */
function requestPeerSubtree(
  runtime: FleetRuntime,
  instanceId: string,
  selection: FleetSelection,
): Promise<Buffer> {
  const msg: PeerLogsCollectRequest = {
    type: 'peer.logs.collect.request',
    messageId: randomUUID(),
    logWindowHours: runtime.logWindowHours,
    // Loop guard: downstream requests never re-traverse the coordinator mesh.
    includeCoordinatorMesh: false,
    selection,
  };
  const outgoing = runtime.peerClients.get(instanceId);
  if (outgoing && outgoing.state === 'connected') {
    return outgoing.sendLogsCollectAndWait(msg, runtime.timeoutMs);
  }
  return runtime.peerHandler.sendLogsCollectAndWait(instanceId, msg, runtime.timeoutMs);
}

/** Map a peer-registry PeerInfo to the fleet-collector peer shape. */
function listFleetPeers(
  runtime: FleetRuntime,
): { instanceId: string; role: 'coordinator' | 'worker'; kind: 'peer' | 'worker' }[] {
  return runtime.peerRegistry.getConnectedPeers().map((p) => ({
    instanceId: p.instanceId,
    role: p.role,
    kind: p.role === 'worker' ? 'worker' : 'peer',
  }));
}

/**
 * Build the FleetCollectorDeps for a given selection of this node's downstream
 * agents/workers. The collector passes per-branch selection in when it knows
 * which downstream subset each peer should gather.
 */
export function buildFleetCollectorDeps(
  runtime: FleetRuntime,
  perBranchSelection: (instanceId: string) => FleetSelection,
): FleetCollectorDeps {
  return {
    instanceId: runtime.instanceId,
    buildLocalBundle: () => buildLocalBundleBuffer(runtime),
    listAgents: () =>
      [...runtime.agentRegistry.getAllEntries()].map((e) => ({ agentId: e.agentId })),
    requestAgentBundle: (agentId) => requestAgentBundle(runtime, agentId),
    listPeers: () => listFleetPeers(runtime),
    requestPeerSubtree: (instanceId) =>
      requestPeerSubtree(runtime, instanceId, perBranchSelection(instanceId)),
  };
}

/** Build the FleetTopologyDeps for `--list` / `--pick` enumeration. */
export function buildFleetTopologyDeps(runtime: FleetRuntime): FleetTopologyDeps {
  return {
    instanceId: runtime.instanceId,
    role: runtime.role,
    hostname: os.hostname(),
    listLocalAgents: () =>
      [...runtime.agentRegistry.getAllEntries()].map((e) => ({
        agentId: e.agentId,
        labels: [...e.labels],
      })),
    listPeers: () =>
      runtime.peerRegistry.getConnectedPeers().map((p) => ({
        instanceId: p.instanceId,
        role: p.role,
        hostname: p.hostname,
        agents: p.agents.map((a) => ({ agentId: a.agentId, labels: a.labels })),
      })),
  };
}

/** Enumerate this node's fleet topology (no fan-out). */
export function getFleetTopology(runtime: FleetRuntime): FleetTopology {
  return buildFleetTopology(buildFleetTopologyDeps(runtime));
}

/**
 * Collect this node's full subtree (root call: includeCoordinatorMesh=true) with
 * an optional per-orchestrator selection map. Absent map entry => collect all.
 */
export function collectFleet(
  runtime: FleetRuntime,
  selectionByOrch: Map<string, FleetSelection> | null,
): Promise<Buffer> {
  const localSelection: FleetSelection = selectionByOrch?.get(runtime.instanceId) ?? {
    all: true,
    agentIds: [],
    workerInstanceIds: [],
  };
  const deps = buildFleetCollectorDeps(
    runtime,
    (instanceId) =>
      selectionByOrch?.get(instanceId) ?? { all: true, agentIds: [], workerInstanceIds: [] },
  );
  return collectFleetSubtree(
    {
      logWindowHours: runtime.logWindowHours,
      selection: localSelection,
      includeCoordinatorMesh: true,
      timeoutMs: runtime.timeoutMs,
    },
    deps,
  );
}

/**
 * Peer-side responder: on an inbound peer.logs.collect.request, assemble this
 * node's subtree (with the request's loop guard + selection) and stream it back
 * as peer.logs.collect.chunk frames, or a peer.logs.collect.error on failure.
 */
export function makeFleetCollectResponder(
  runtime: FleetRuntime,
): (msg: PeerLogsCollectRequest, send: (out: PeerToPeerMessage) => boolean) => Promise<void> {
  return async (msg, send) => {
    try {
      const deps = buildFleetCollectorDeps(runtime, () => msg.selection);
      const buf = await collectFleetSubtree(
        {
          logWindowHours: msg.logWindowHours,
          selection: msg.selection,
          includeCoordinatorMesh: msg.includeCoordinatorMesh,
          timeoutMs: runtime.timeoutMs,
        },
        deps,
      );
      for (const f of chunkBuffer(buf)) {
        send({
          type: 'peer.logs.collect.chunk',
          messageId: msg.messageId,
          seq: f.seq,
          isLast: f.isLast,
          dataB64: f.dataB64,
        });
      }
    } catch (err) {
      send({
        type: 'peer.logs.collect.error',
        messageId: msg.messageId,
        message: toErrorMessage(err),
      });
    }
  };
}
