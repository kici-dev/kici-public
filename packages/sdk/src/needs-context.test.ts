import { describe, it, expect } from 'vitest';
import { buildNeedsContext } from './needs-context.js';

const snapshot = {
  jobs: {
    discover: { targets: ['a', 'b'] },
    'scan-a': { findings: 1 },
    'scan-b': { findings: 2 },
  },
  groups: { 'scan-shards': ['scan-a', 'scan-b'] },
};

describe('buildNeedsContext', () => {
  it('resolves a single-job need as { result: <outputs> }', () => {
    const needs = buildNeedsContext(snapshot, ['discover']);
    expect((needs.discover as { result: { targets: string[] } }).result.targets).toEqual([
      'a',
      'b',
    ]);
  });

  it('resolves a group need as an ordered array of { name, result }', () => {
    const needs = buildNeedsContext(snapshot, [{ group: 'scan-shards' }]);
    const arr = needs['scan-shards'] as Array<{ name: string; result: { findings: number } }>;
    expect(arr.map((e) => e.name)).toEqual(['scan-a', 'scan-b']);
    expect(arr.map((e) => e.result.findings)).toEqual([1, 2]);
  });

  it('throws a clear error when a single-job need has no snapshot entry', () => {
    expect(() => {
      const n = buildNeedsContext({ jobs: {}, groups: {} }, ['missing']);
      void (n.missing as { result: Record<string, unknown> }).result.x;
    }).toThrow(/missing/);
  });
});
