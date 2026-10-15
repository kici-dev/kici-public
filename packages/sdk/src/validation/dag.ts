/** A node of a job dependency graph. */
export interface DagNode {
  id: string;
  needs: string[];
}

export type DagValidationResult =
  | { valid: true; sortedOrder: string[] }
  | { valid: false; error: 'cycle'; nodesInCycle: string[] }
  | { valid: false; error: 'self-reference'; nodeId: string }
  | { valid: false; error: 'missing-dependency'; nodeId: string; missingDep: string };

/**
 * Checks, in order, for self-references, missing dependencies and cycles
 * (Kahn's algorithm, which also yields the topological order). The first
 * failure found is returned.
 */
export function validateDag(nodes: DagNode[]): DagValidationResult {
  if (nodes.length === 0) {
    return { valid: true, sortedOrder: [] };
  }

  const nodeIds = new Set(nodes.map((n) => n.id));

  for (const node of nodes) {
    if (node.needs.includes(node.id)) {
      return { valid: false, error: 'self-reference', nodeId: node.id };
    }
  }

  for (const node of nodes) {
    for (const dep of node.needs) {
      if (!nodeIds.has(dep)) {
        return { valid: false, error: 'missing-dependency', nodeId: node.id, missingDep: dep };
      }
    }
  }

  const adjacencyList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    adjacencyList.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const node of nodes) {
    for (const dep of node.needs) {
      adjacencyList.get(dep)!.push(node.id);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const sortedOrder: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sortedOrder.push(current);

    for (const neighbor of adjacencyList.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (sortedOrder.length !== nodes.length) {
    // The residual (in-degree > 0) is the cycle PLUS its downstream dependents.
    // Peeling sinks (no successor left in the residual) to a fixpoint leaves
    // exactly the cycle members: Kahn's already drained everything upstream,
    // and each cycle member keeps an out-edge into the residual.
    const residual = new Set<string>();
    for (const [id, degree] of inDegree) {
      if (degree > 0) {
        residual.add(id);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const id of residual) {
        const hasSuccessorInResidual = (adjacencyList.get(id) ?? []).some((target) =>
          residual.has(target),
        );
        if (!hasSuccessorInResidual) {
          residual.delete(id);
          changed = true;
        }
      }
    }

    return { valid: false, error: 'cycle', nodesInCycle: [...residual] };
  }

  return { valid: true, sortedOrder };
}
