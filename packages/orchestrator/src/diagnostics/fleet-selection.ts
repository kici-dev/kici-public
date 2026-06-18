/**
 * Fleet --pick selector resolution.
 *
 * Resolves a list of `--pick` selectors against the enumerated topology and
 * computes a per-orchestrator FleetSelection: which of that orchestrator's
 * agents (and which downstream workers) the collector should gather. Empty
 * selectors mean "everything" (`all: true` for every orchestrator). A branch
 * with nothing selected is pruned (no request issued).
 *
 * Selector forms:
 *   - exact instanceId / agentId      e.g. `coord-a`, `agent-7`
 *   - hostname glob                    e.g. `host-*`
 *   - `label:<k>=<v>` on agent labels  e.g. `label:env=prod`
 */
import picomatch from 'picomatch';
import type { FleetSelection } from '@kici-dev/engine';
import type { FleetTopology, FleetTopologyNode } from './fleet-topology.js';

/** A per-orchestrator selection, keyed by orchestrator instanceId. Absent = prune. */
export type ResolvedSelectionMap = Map<string, FleetSelection>;

/** Does the selector match this node by exact id, hostname glob, or agent label? */
function selectorMatchesNode(selector: string, node: FleetTopologyNode): boolean {
  if (selector.startsWith('label:')) {
    const body = selector.slice('label:'.length);
    const eq = body.indexOf('=');
    if (eq === -1) return node.labels[body] !== undefined;
    const key = body.slice(0, eq);
    const value = body.slice(eq + 1);
    return node.labels[key] === value;
  }
  if (selector === node.id) return true;
  if (node.hostname && picomatch.isMatch(node.hostname, selector)) return true;
  // A glob selector may also match an id (e.g. `agent-*`).
  return picomatch.isMatch(node.id, selector);
}

/**
 * Resolve `--pick` selectors into a per-orchestrator FleetSelection map.
 *
 * No selectors -> every orchestrator gets `{ all: true }`. With selectors, an
 * orchestrator is included only if at least one of its agents/workers (or the
 * orchestrator itself) matches; its FleetSelection then carries exactly the
 * matched agent ids and worker instanceIds. Orchestrators with no matches are
 * omitted from the map (their branch is pruned).
 */
export function resolveSelection(
  topology: FleetTopology,
  selectors: string[],
): ResolvedSelectionMap {
  const orchestrators = topology.nodes.filter((n) => n.kind === 'orchestrator');
  const map: ResolvedSelectionMap = new Map();

  if (selectors.length === 0) {
    for (const o of orchestrators) {
      map.set(o.id, { all: true, agentIds: [], workerInstanceIds: [] });
    }
    return map;
  }

  const matches = (node: FleetTopologyNode): boolean =>
    selectors.some((s) => selectorMatchesNode(s, node));

  // An orchestrator is selected wholesale when it (or its hostname) matches a
  // selector directly. Otherwise only its individually-matched children count.
  for (const o of orchestrators) {
    const childAgents = topology.nodes.filter((n) => n.kind === 'agent' && n.parentId === o.id);
    const childWorkers = orchestrators.filter((n) => n.role === 'worker' && n.parentId === o.id);

    if (matches(o)) {
      map.set(o.id, { all: true, agentIds: [], workerInstanceIds: [] });
      continue;
    }

    const agentIds = childAgents.filter(matches).map((n) => n.id);
    const workerInstanceIds = childWorkers.filter(matches).map((n) => n.id);

    if (agentIds.length > 0 || workerInstanceIds.length > 0) {
      map.set(o.id, { all: false, agentIds, workerInstanceIds });
    }
  }

  return map;
}
