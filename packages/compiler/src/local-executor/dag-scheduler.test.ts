import { describe, it, expect, vi } from 'vitest';
import { executeDag, resolveJobFilter } from './dag-scheduler.js';
import type { DagNode, DagExecutionCallbacks, DagOptions, DagResult } from './dag-scheduler.js';

/**
 * Helper to create a simple node.
 */
function node(name: string, needs: string[] = []): DagNode {
  return { name, needs };
}

/**
 * Helper to create callbacks that track execution order and concurrency.
 */
function createTracker(opts?: { durations?: Record<string, number>; failures?: Set<string> }) {
  const executionOrder: string[] = [];
  const concurrencyLog: number[] = [];
  let currentConcurrency = 0;

  const callbacks: DagExecutionCallbacks<{ name: string; ok: boolean }> = {
    execute: async (name, signal) => {
      currentConcurrency++;
      concurrencyLog.push(currentConcurrency);
      executionOrder.push(name);

      const duration = opts?.durations?.[name] ?? 10;
      await new Promise((resolve) => setTimeout(resolve, duration));

      if (signal.aborted) {
        currentConcurrency--;
        return { name, ok: false };
      }

      currentConcurrency--;

      if (opts?.failures?.has(name)) {
        return { name, ok: false };
      }
      return { name, ok: true };
    },
    isSuccess: (result) => result.ok,
  };

  return { callbacks, executionOrder, concurrencyLog };
}

describe('executeDag', () => {
  describe('dependency resolution', () => {
    it('executes jobs with no dependencies immediately', async () => {
      const nodes = [node('A'), node('B'), node('C')];
      const { callbacks, executionOrder } = createTracker();

      const result = await executeDag(nodes, callbacks, {
        maxConcurrency: 3,
        failFast: true,
      });

      expect(result.status).toBe('success');
      expect(result.results.size).toBe(3);
      expect(result.skipped).toEqual([]);
      expect(result.cancelled).toEqual([]);
      // All three should have started (order may vary due to parallelism)
      expect(executionOrder).toHaveLength(3);
      expect(new Set(executionOrder)).toEqual(new Set(['A', 'B', 'C']));
    });

    it('executes linear chain A->B->C in order', async () => {
      const nodes = [node('A'), node('B', ['A']), node('C', ['B'])];
      const { callbacks, executionOrder } = createTracker();

      const result = await executeDag(nodes, callbacks, {
        maxConcurrency: 3,
        failFast: true,
      });

      expect(result.status).toBe('success');
      expect(executionOrder).toEqual(['A', 'B', 'C']);
    });

    it('executes diamond A->{B,C}->D correctly', async () => {
      const nodes = [node('A'), node('B', ['A']), node('C', ['A']), node('D', ['B', 'C'])];
      const { callbacks, executionOrder } = createTracker();

      const result = await executeDag(nodes, callbacks, {
        maxConcurrency: 2,
        failFast: true,
      });

      expect(result.status).toBe('success');
      // A must be first
      expect(executionOrder[0]).toBe('A');
      // B and C can be in any order but both before D
      expect(executionOrder).toContain('B');
      expect(executionOrder).toContain('C');
      expect(executionOrder[3]).toBe('D');
    });

    it('skips jobs whose dependencies failed', async () => {
      const nodes = [node('A'), node('B', ['A']), node('C', ['B'])];
      const { callbacks, executionOrder } = createTracker({ failures: new Set(['A']) });

      const result = await executeDag(nodes, callbacks, {
        maxConcurrency: 3,
        failFast: false,
      });

      expect(result.status).toBe('failure');
      expect(executionOrder).toEqual(['A']);
      expect(result.skipped.sort()).toEqual(['B', 'C']);
    });

    it('detects circular dependencies and throws', async () => {
      const nodes = [node('A', ['C']), node('B', ['A']), node('C', ['B'])];
      const { callbacks } = createTracker();

      await expect(
        executeDag(nodes, callbacks, { maxConcurrency: 3, failFast: true }),
      ).rejects.toThrow(/circular/i);
    });
  });

  describe('concurrency control', () => {
    it('never exceeds maxConcurrency', async () => {
      const nodes = [node('A'), node('B'), node('C'), node('D'), node('E')];
      const { callbacks, concurrencyLog } = createTracker({
        durations: { A: 50, B: 50, C: 50, D: 50, E: 50 },
      });

      await executeDag(nodes, callbacks, {
        maxConcurrency: 2,
        failFast: true,
      });

      expect(Math.max(...concurrencyLog)).toBeLessThanOrEqual(2);
    });

    it('with concurrency=1 runs sequentially', async () => {
      const nodes = [node('A'), node('B'), node('C')];
      const { callbacks, concurrencyLog } = createTracker();

      await executeDag(nodes, callbacks, {
        maxConcurrency: 1,
        failFast: true,
      });

      expect(Math.max(...concurrencyLog)).toBe(1);
    });

    it('with concurrency=Infinity runs all independent jobs in parallel', async () => {
      const nodes = [node('A'), node('B'), node('C'), node('D')];
      const { callbacks, concurrencyLog } = createTracker({
        durations: { A: 50, B: 50, C: 50, D: 50 },
      });

      await executeDag(nodes, callbacks, {
        maxConcurrency: Infinity,
        failFast: true,
      });

      expect(Math.max(...concurrencyLog)).toBe(4);
    });
  });

  describe('fail-fast mode', () => {
    it('cancels running siblings and skips pending when a job fails', async () => {
      // A has no deps, B and C depend on A, D depends on B
      // B fails, C should be cancelled (if still running), D skipped
      const nodes = [node('A'), node('B', ['A']), node('C', ['A']), node('D', ['B'])];
      const { callbacks, executionOrder } = createTracker({
        failures: new Set(['B']),
        durations: { B: 10, C: 100 }, // C takes longer so it's still running when B fails
      });

      const result = await executeDag(nodes, callbacks, {
        maxConcurrency: 3,
        failFast: true,
      });

      expect(result.status).toBe('failure');
      // A ran, B ran (failed), C may have started but should be cancelled
      expect(executionOrder).toContain('A');
      expect(executionOrder).toContain('B');
      // D should never have started
      expect(result.skipped).toContain('D');
    });

    it('abort signal is triggered for running jobs', async () => {
      const abortedNames: string[] = [];
      const nodes = [node('A'), node('B')];

      const callbacks: DagExecutionCallbacks<{ name: string; ok: boolean }> = {
        execute: async (name, signal) => {
          if (name === 'A') {
            return { name, ok: false }; // Fail immediately
          }
          // B should receive abort
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (signal.aborted) {
            abortedNames.push(name);
          }
          return { name, ok: signal.aborted ? false : true };
        },
        isSuccess: (r) => r.ok,
      };

      await executeDag(nodes, callbacks, {
        maxConcurrency: 2,
        failFast: true,
      });

      expect(abortedNames).toContain('B');
    });
  });

  describe('keep-going mode (failFast=false)', () => {
    it('continues independent jobs after failure', async () => {
      // A and B are independent, C depends on A
      const nodes = [node('A'), node('B'), node('C', ['A'])];
      const { callbacks, executionOrder } = createTracker({
        failures: new Set(['A']),
      });

      const result = await executeDag(nodes, callbacks, {
        maxConcurrency: 3,
        failFast: false,
      });

      expect(result.status).toBe('failure');
      // Both A and B should have run
      expect(executionOrder).toContain('A');
      expect(executionOrder).toContain('B');
      // C depends on A which failed, so C should be skipped
      expect(result.skipped).toContain('C');
      // B should have succeeded
      expect(result.results.get('B')?.ok).toBe(true);
    });

    it('only skips transitive dependents of failed jobs', async () => {
      // A fails, B depends on A, C is independent, D depends on B
      const nodes = [node('A'), node('B', ['A']), node('C'), node('D', ['B'])];
      const { callbacks, executionOrder } = createTracker({
        failures: new Set(['A']),
      });

      const result = await executeDag(nodes, callbacks, {
        maxConcurrency: 3,
        failFast: false,
      });

      expect(result.status).toBe('failure');
      expect(executionOrder).toContain('A');
      expect(executionOrder).toContain('C');
      expect(result.skipped.sort()).toEqual(['B', 'D']);
    });
  });

  describe('abort error handling', () => {
    it('records jobs as cancelled when their promise rejects during abort', async () => {
      const nodes = [node('A'), node('B')];

      const callbacks: DagExecutionCallbacks<{ name: string; ok: boolean }> = {
        execute: async (name, signal) => {
          if (name === 'A') {
            return { name, ok: false }; // Fail immediately to trigger abort
          }
          // B throws an error when aborted
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (signal.aborted) {
            throw new Error('Aborted job threw unexpectedly');
          }
          return { name, ok: true };
        },
        isSuccess: (r) => r.ok,
      };

      const result = await executeDag(nodes, callbacks, {
        maxConcurrency: 2,
        failFast: true,
      });

      expect(result.status).toBe('failure');
      // B should be in cancelled, not silently dropped
      expect(result.cancelled).toContain('B');
    });
  });

  describe('rejection handling', () => {
    it('propagates rejection without orphaned unhandled rejections', async () => {
      // When multiple jobs run concurrently and one throws, the Promise.race
      // wrapper promises for other jobs must not produce unhandled rejections
      const nodes = [node('A'), node('B')];

      const callbacks: DagExecutionCallbacks<{ name: string; ok: boolean }> = {
        execute: async (name) => {
          if (name === 'A') {
            await new Promise((resolve) => setTimeout(resolve, 20));
            throw new Error('A exploded');
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { name, ok: true };
        },
        isSuccess: (r) => r.ok,
      };

      await expect(
        executeDag(nodes, callbacks, { maxConcurrency: 2, failFast: true }),
      ).rejects.toThrow('A exploded');
    });
  });

  describe('edge cases', () => {
    it('handles empty job list', async () => {
      const { callbacks } = createTracker();

      const result = await executeDag([], callbacks, {
        maxConcurrency: 3,
        failFast: true,
      });

      expect(result.status).toBe('success');
      expect(result.results.size).toBe(0);
    });

    it('handles single job', async () => {
      const { callbacks, executionOrder } = createTracker();

      const result = await executeDag([node('only')], callbacks, {
        maxConcurrency: 1,
        failFast: true,
      });

      expect(result.status).toBe('success');
      expect(executionOrder).toEqual(['only']);
    });
  });
});

describe('resolveJobFilter', () => {
  it('returns target job plus all transitive dependencies', () => {
    const nodes = [node('A'), node('B', ['A']), node('C', ['B']), node('D', ['C'])];

    const filtered = resolveJobFilter(nodes, 'D');
    const names = filtered.map((n) => n.name);
    expect(names).toEqual(['A', 'B', 'C', 'D']);
  });

  it('returns only the target if it has no dependencies', () => {
    const nodes = [node('A'), node('B'), node('C')];

    const filtered = resolveJobFilter(nodes, 'B');
    expect(filtered.map((n) => n.name)).toEqual(['B']);
  });

  it('includes diamond dependencies correctly', () => {
    const nodes = [node('A'), node('B', ['A']), node('C', ['A']), node('D', ['B', 'C'])];

    const filtered = resolveJobFilter(nodes, 'D');
    const names = filtered.map((n) => n.name);
    // Must include A, B, C, D in topological order
    expect(names).toContain('A');
    expect(names).toContain('B');
    expect(names).toContain('C');
    expect(names).toContain('D');
    // A must come before B and C
    expect(names.indexOf('A')).toBeLessThan(names.indexOf('B'));
    expect(names.indexOf('A')).toBeLessThan(names.indexOf('C'));
    // B and C must come before D
    expect(names.indexOf('B')).toBeLessThan(names.indexOf('D'));
    expect(names.indexOf('C')).toBeLessThan(names.indexOf('D'));
  });

  it('returns empty array if target job not found', () => {
    const nodes = [node('A'), node('B')];

    expect(resolveJobFilter(nodes, 'Z')).toEqual([]);
  });
});
