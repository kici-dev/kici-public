import { describe, it, expect } from 'vitest';
import { validateDag } from './dag.js';
import type { DagNode } from './dag.js';

describe('validateDag()', () => {
  it('returns valid for empty array', () => {
    const result = validateDag([]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.sortedOrder).toEqual([]);
    }
  });

  it('returns valid for single node with no deps', () => {
    const nodes: DagNode[] = [{ id: 'A', needs: [] }];
    const result = validateDag(nodes);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.sortedOrder).toEqual(['A']);
    }
  });

  it('returns valid for linear chain (A -> B -> C)', () => {
    const nodes: DagNode[] = [
      { id: 'C', needs: ['B'] },
      { id: 'B', needs: ['A'] },
      { id: 'A', needs: [] },
    ];
    const result = validateDag(nodes);
    expect(result.valid).toBe(true);
    if (result.valid) {
      // A must come before B, B must come before C
      const indexA = result.sortedOrder.indexOf('A');
      const indexB = result.sortedOrder.indexOf('B');
      const indexC = result.sortedOrder.indexOf('C');
      expect(indexA).toBeLessThan(indexB);
      expect(indexB).toBeLessThan(indexC);
    }
  });

  it('returns valid for diamond pattern (A -> B, A -> C, B -> D, C -> D)', () => {
    const nodes: DagNode[] = [
      { id: 'A', needs: [] },
      { id: 'B', needs: ['A'] },
      { id: 'C', needs: ['A'] },
      { id: 'D', needs: ['B', 'C'] },
    ];
    const result = validateDag(nodes);
    expect(result.valid).toBe(true);
    if (result.valid) {
      // A must come before B and C, B and C must come before D
      const indexA = result.sortedOrder.indexOf('A');
      const indexB = result.sortedOrder.indexOf('B');
      const indexC = result.sortedOrder.indexOf('C');
      const indexD = result.sortedOrder.indexOf('D');
      expect(indexA).toBeLessThan(indexB);
      expect(indexA).toBeLessThan(indexC);
      expect(indexB).toBeLessThan(indexD);
      expect(indexC).toBeLessThan(indexD);
    }
  });

  it('detects self-reference (A needs A)', () => {
    const nodes: DagNode[] = [{ id: 'A', needs: ['A'] }];
    const result = validateDag(nodes);
    expect(result.valid).toBe(false);
    if (result.valid === false && result.error === 'self-reference') {
      expect(result.nodeId).toBe('A');
    }
  });

  it('detects simple cycle (A -> B -> A)', () => {
    const nodes: DagNode[] = [
      { id: 'A', needs: ['B'] },
      { id: 'B', needs: ['A'] },
    ];
    const result = validateDag(nodes);
    expect(result.valid).toBe(false);
    if (result.valid === false && result.error === 'cycle') {
      expect(result.nodesInCycle).toContain('A');
      expect(result.nodesInCycle).toContain('B');
    }
  });

  it('detects complex cycle (A -> B -> C -> A)', () => {
    const nodes: DagNode[] = [
      { id: 'A', needs: ['C'] },
      { id: 'B', needs: ['A'] },
      { id: 'C', needs: ['B'] },
    ];
    const result = validateDag(nodes);
    expect(result.valid).toBe(false);
    if (result.valid === false && result.error === 'cycle') {
      expect(result.nodesInCycle).toContain('A');
      expect(result.nodesInCycle).toContain('B');
      expect(result.nodesInCycle).toContain('C');
    }
  });

  it('detects cycle in larger graph (some nodes not in cycle)', () => {
    // D and E have a cycle, but A, B, C are fine
    const nodes: DagNode[] = [
      { id: 'A', needs: [] },
      { id: 'B', needs: ['A'] },
      { id: 'C', needs: ['B'] },
      { id: 'D', needs: ['C', 'E'] }, // D needs E
      { id: 'E', needs: ['D'] }, // E needs D -> cycle
    ];
    const result = validateDag(nodes);
    expect(result.valid).toBe(false);
    if (result.valid === false && result.error === 'cycle') {
      expect(result.nodesInCycle).toContain('D');
      expect(result.nodesInCycle).toContain('E');
      // A, B, C should NOT be in cycle (they'll be processed successfully)
      expect(result.nodesInCycle).not.toContain('A');
      expect(result.nodesInCycle).not.toContain('B');
      expect(result.nodesInCycle).not.toContain('C');
    }
  });

  it('returns sortedOrder in topological order for valid DAGs', () => {
    const nodes: DagNode[] = [
      { id: 'build', needs: [] },
      { id: 'test', needs: ['build'] },
      { id: 'deploy', needs: ['test'] },
    ];
    const result = validateDag(nodes);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.sortedOrder).toEqual(['build', 'test', 'deploy']);
    }
  });

  it('detects missing dependency (A needs B, but B does not exist)', () => {
    const nodes: DagNode[] = [{ id: 'A', needs: ['B'] }];
    const result = validateDag(nodes);
    expect(result.valid).toBe(false);
    if (result.valid === false && result.error === 'missing-dependency') {
      expect(result.nodeId).toBe('A');
      expect(result.missingDep).toBe('B');
    }
  });

  it('handles multiple independent subgraphs', () => {
    const nodes: DagNode[] = [
      { id: 'A', needs: [] },
      { id: 'B', needs: ['A'] },
      { id: 'X', needs: [] },
      { id: 'Y', needs: ['X'] },
    ];
    const result = validateDag(nodes);
    expect(result.valid).toBe(true);
    if (result.valid) {
      // A before B, X before Y (but A/B independent of X/Y)
      expect(result.sortedOrder.indexOf('A')).toBeLessThan(result.sortedOrder.indexOf('B'));
      expect(result.sortedOrder.indexOf('X')).toBeLessThan(result.sortedOrder.indexOf('Y'));
    }
  });
});
