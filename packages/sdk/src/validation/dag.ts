/**
 * Represents a node in a Directed Acyclic Graph.
 * Used for validating job dependency graphs.
 */
export interface DagNode {
  id: string;
  needs: string[];
}

/**
 * Result of DAG validation.
 * Discriminated union for different validation outcomes.
 */
export type DagValidationResult =
  | { valid: true; sortedOrder: string[] }
  | { valid: false; error: 'cycle'; nodesInCycle: string[] }
  | { valid: false; error: 'self-reference'; nodeId: string }
  | { valid: false; error: 'missing-dependency'; nodeId: string; missingDep: string };

/**
 * Validate a DAG for common issues: self-references, missing dependencies, and cycles.
 *
 * Validation order:
 * 1. Check for self-references (node depends on itself)
 * 2. Check for missing dependencies (depends on non-existent node)
 * 3. Check for cycles using Kahn's algorithm
 *
 * @param nodes - Array of DAG nodes to validate
 * @returns Validation result with error details or sorted order
 */
export function validateDag(nodes: DagNode[]): DagValidationResult {
  // Empty graph is valid
  if (nodes.length === 0) {
    return { valid: true, sortedOrder: [] };
  }

  // Build set of all node IDs for lookup
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Check for self-references first
  for (const node of nodes) {
    if (node.needs.includes(node.id)) {
      return { valid: false, error: 'self-reference', nodeId: node.id };
    }
  }

  // Check for missing dependencies
  for (const node of nodes) {
    for (const dep of node.needs) {
      if (!nodeIds.has(dep)) {
        return { valid: false, error: 'missing-dependency', nodeId: node.id, missingDep: dep };
      }
    }
  }

  // Check for cycles using Kahn's algorithm
  // We need to compute topological sort anyway, so reuse the logic
  const adjacencyList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  // Initialize
  for (const node of nodes) {
    adjacencyList.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  // Build graph
  for (const node of nodes) {
    for (const dep of node.needs) {
      adjacencyList.get(dep)!.push(node.id);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  // BFS topological sort
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

  // Check for cycle
  if (sortedOrder.length !== nodes.length) {
    const cycleNodes: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree > 0) {
        cycleNodes.push(id);
      }
    }
    return { valid: false, error: 'cycle', nodesInCycle: cycleNodes };
  }

  return { valid: true, sortedOrder };
}
