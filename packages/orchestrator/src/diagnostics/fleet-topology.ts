/**
 * Fleet topology enumeration.
 *
 * Builds the cluster tree for `debug-bundle --fleet --list` / `--pick` from the
 * local agent registry plus the heartbeat-cached peer inventory — no fan-out.
 * Each peer's cached agent list is already maintained by ~30s heartbeats, so
 * enumeration is a cheap in-memory read.
 */

/** A node in the enumerated fleet topology. */
export interface FleetTopologyNode {
  kind: 'orchestrator' | 'agent';
  id: string;
  /** Cluster role for orchestrator nodes (coordinator | worker); undefined for agents. */
  role?: 'coordinator' | 'worker';
  hostname?: string;
  labels: Record<string, string>;
  /** Parent orchestrator instanceId; null for the collector (root) node. */
  parentId: string | null;
}

export interface FleetTopology {
  nodes: FleetTopologyNode[];
}

export interface FleetTopologyDeps {
  /** This collector's own instanceId (the root orchestrator). */
  instanceId: string;
  /** This collector's role. */
  role: 'coordinator' | 'worker';
  /** This collector's hostname, if known. */
  hostname?: string;
  /** This node's directly-connected agents. */
  listLocalAgents: () => { agentId: string; labels: string[] }[];
  /** The heartbeat-cached peer inventory (each peer + its cached agents). */
  listPeers: () => {
    instanceId: string;
    role: 'coordinator' | 'worker';
    hostname?: string;
    agents: { agentId: string; labels: string[] }[];
  }[];
}

/** Convert a flat label list (`k=v` or bare flags) into a `Record<string,string>`. */
function labelsToRecord(labels: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const label of labels) {
    const eq = label.indexOf('=');
    if (eq === -1) record[label] = '';
    else record[label.slice(0, eq)] = label.slice(eq + 1);
  }
  return record;
}

export function buildFleetTopology(deps: FleetTopologyDeps): FleetTopology {
  const nodes: FleetTopologyNode[] = [];

  // Root orchestrator (the collector).
  nodes.push({
    kind: 'orchestrator',
    id: deps.instanceId,
    role: deps.role,
    hostname: deps.hostname,
    labels: {},
    parentId: null,
  });

  // Root's own agents.
  for (const a of deps.listLocalAgents()) {
    nodes.push({
      kind: 'agent',
      id: a.agentId,
      labels: labelsToRecord(a.labels),
      parentId: deps.instanceId,
    });
  }

  // Peers (coordinator-mesh peers + workers) and each peer's cached agents.
  for (const peer of deps.listPeers()) {
    nodes.push({
      kind: 'orchestrator',
      id: peer.instanceId,
      role: peer.role,
      hostname: peer.hostname,
      labels: {},
      parentId: deps.instanceId,
    });
    for (const a of peer.agents) {
      nodes.push({
        kind: 'agent',
        id: a.agentId,
        labels: labelsToRecord(a.labels),
        parentId: peer.instanceId,
      });
    }
  }

  return { nodes };
}
