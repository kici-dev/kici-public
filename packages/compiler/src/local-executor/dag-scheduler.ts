/**
 * DAG-based parallel job scheduler with concurrency control and fail-fast.
 *
 * Generic scheduler that takes nodes with dependency relationships and
 * executes them via callbacks, respecting concurrency limits and
 * providing abort signals for fail-fast cancellation.
 */

export interface DagNode {
  name: string;
  needs: string[];
}

interface DagExecutionCallbacks<T> {
  execute: (name: string, signal: AbortSignal) => Promise<T>;
  isSuccess: (result: T) => boolean;
}

interface DagOptions {
  maxConcurrency: number;
  failFast: boolean;
}

interface DagResult<T> {
  results: Map<string, T>;
  skipped: string[];
  cancelled: string[];
  status: 'success' | 'failure';
}

/**
 * Detect cycles using Kahn's algorithm.
 * Returns true if a cycle exists.
 */
function detectCycle(nodes: DagNode[]): boolean {
  const inDegree = new Map<string, number>();

  for (const n of nodes) {
    if (!inDegree.has(n.name)) inDegree.set(n.name, 0);
    for (const dep of n.needs) {
      inDegree.set(n.name, (inDegree.get(n.name) ?? 0) + 1);
      if (!inDegree.has(dep)) inDegree.set(dep, 0);
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  let processed = 0;
  while (queue.length > 0) {
    const name = queue.shift()!;
    processed++;

    // Find nodes that depend on this one
    for (const n of nodes) {
      if (n.needs.includes(name)) {
        const newDeg = inDegree.get(n.name)! - 1;
        inDegree.set(n.name, newDeg);
        if (newDeg === 0) queue.push(n.name);
      }
    }
  }

  return processed < nodes.length;
}

/**
 * Execute a DAG of nodes with bounded concurrency and fail-fast support.
 *
 * Algorithm:
 * 1. Detect cycles
 * 2. Initialize ready queue with zero-dependency nodes
 * 3. Event loop: launch ready nodes up to concurrency limit,
 *    await first completion, update state, repeat
 * 4. On failure: if failFast, abort all running and skip pending;
 *    if keep-going, only skip transitive dependents
 */
export async function executeDag<T>(
  nodes: DagNode[],
  callbacks: DagExecutionCallbacks<T>,
  options: DagOptions,
): Promise<DagResult<T>> {
  // Handle empty input
  if (nodes.length === 0) {
    return { results: new Map(), skipped: [], cancelled: [], status: 'success' };
  }

  // Detect cycles
  if (detectCycle(nodes)) {
    throw new Error('Circular dependency detected in job graph');
  }

  const nodeMap = new Map(nodes.map((n) => [n.name, n]));
  const results = new Map<string, T>();
  const skipped: string[] = [];
  const cancelled: string[] = [];
  const failedNames = new Set<string>();
  const pending = new Set(nodes.map((n) => n.name));
  const running = new Map<string, { promise: Promise<T>; controller: AbortController }>();
  let hasFailure = false;
  let abortAll = false;

  /**
   * Check if a node is ready to execute:
   * all dependencies completed successfully.
   */
  function isReady(name: string): boolean {
    const node = nodeMap.get(name)!;
    return node.needs.every((dep) => results.has(dep) && callbacks.isSuccess(results.get(dep)!));
  }

  /**
   * Check if a node should be skipped because a dependency failed.
   */
  function shouldSkip(name: string): boolean {
    const node = nodeMap.get(name)!;
    return node.needs.some(
      (dep) => failedNames.has(dep) || skipped.includes(dep) || cancelled.includes(dep),
    );
  }

  // Main scheduling loop
  while (pending.size > 0 || running.size > 0) {
    if (abortAll) {
      // Move all pending to skipped
      for (const name of pending) {
        skipped.push(name);
      }
      pending.clear();

      // Wait for running jobs to complete (they have already been aborted)
      if (running.size > 0) {
        const entries = [...running.entries()];
        const settled = await Promise.allSettled(entries.map(([, v]) => v.promise));
        for (let i = 0; i < entries.length; i++) {
          const [name] = entries[i];
          const s = settled[i];
          if (s.status === 'fulfilled') {
            results.set(name, s.value);
            if (!callbacks.isSuccess(s.value)) {
              cancelled.push(name);
            }
          } else {
            // Promise rejected (unexpected throw during abort) — record as cancelled
            cancelled.push(name);
          }
          running.delete(name);
        }
      }
      break;
    }

    // Mark pending nodes that should be skipped (deps failed in keep-going mode).
    // Loop until stable because transitive dependents may need multiple passes.
    let skipChanged = true;
    while (skipChanged) {
      skipChanged = false;
      const toSkip: string[] = [];
      for (const name of pending) {
        if (shouldSkip(name)) {
          toSkip.push(name);
        }
      }
      for (const name of toSkip) {
        pending.delete(name);
        skipped.push(name);
        skipChanged = true;
      }
    }

    // Find ready nodes and launch up to concurrency limit
    const readyNodes: string[] = [];
    for (const name of pending) {
      if (running.size + readyNodes.length >= options.maxConcurrency) break;
      if (isReady(name)) {
        readyNodes.push(name);
      }
    }

    // Launch ready nodes
    for (const name of readyNodes) {
      pending.delete(name);
      const controller = new AbortController();
      const promise = callbacks.execute(name, controller.signal);
      running.set(name, { promise, controller });
    }

    // If nothing is running and nothing is ready, we're done
    if (running.size === 0) {
      break;
    }

    // Wait for at least one running job to complete
    const entries = [...running.entries()];
    const wrappedPromises = entries.map(async ([name, { promise }]) => {
      const result = await promise;
      return { name, result };
    });

    // Prevent unhandled rejections on promises that lose the race —
    // orphaned wrappers from previous iterations would crash the process
    for (const p of wrappedPromises) {
      p.catch(() => {});
    }

    const raceResult = await Promise.race(wrappedPromises);

    // Process the completed job
    const { name: completedName, result: completedResult } = raceResult;
    running.delete(completedName);
    results.set(completedName, completedResult);

    if (!callbacks.isSuccess(completedResult)) {
      hasFailure = true;
      failedNames.add(completedName);

      if (options.failFast) {
        // Abort all running jobs
        for (const [, { controller }] of running) {
          controller.abort();
        }
        abortAll = true;
      }
    }
  }

  return {
    results,
    skipped,
    cancelled,
    status: hasFailure || skipped.length > 0 || cancelled.length > 0 ? 'failure' : 'success',
  };
}

/**
 * Given a list of DAG nodes and a target job name, return the target
 * plus all transitive dependencies in topological order.
 */
export function resolveJobFilter(nodes: DagNode[], targetName: string): DagNode[] {
  const nodeMap = new Map(nodes.map((n) => [n.name, n]));

  if (!nodeMap.has(targetName)) {
    return [];
  }

  // Collect all transitive dependencies via BFS
  const needed = new Set<string>();
  const queue = [targetName];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (needed.has(name)) continue;
    needed.add(name);

    const node = nodeMap.get(name);
    if (node) {
      for (const dep of node.needs) {
        if (!needed.has(dep)) {
          queue.push(dep);
        }
      }
    }
  }

  // Return in topological order using Kahn's algorithm on the subset
  const subset = nodes.filter((n) => needed.has(n.name));
  const inDegree = new Map<string, number>();

  for (const n of subset) {
    if (!inDegree.has(n.name)) inDegree.set(n.name, 0);
    for (const dep of n.needs) {
      if (needed.has(dep)) {
        inDegree.set(n.name, (inDegree.get(n.name) ?? 0) + 1);
      }
    }
  }

  const result: DagNode[] = [];
  const topoQueue: string[] = [];

  for (const [name, deg] of inDegree) {
    if (deg === 0) topoQueue.push(name);
  }

  while (topoQueue.length > 0) {
    const name = topoQueue.shift()!;
    result.push(nodeMap.get(name)!);

    for (const n of subset) {
      if (n.needs.includes(name) && needed.has(n.name)) {
        const newDeg = inDegree.get(n.name)! - 1;
        inDegree.set(n.name, newDeg);
        if (newDeg === 0) topoQueue.push(n.name);
      }
    }
  }

  return result;
}
