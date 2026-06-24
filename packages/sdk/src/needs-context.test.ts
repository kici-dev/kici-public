import { describe, it, expect } from 'vitest';
import { buildNeedsContext } from './needs-context.js';

const snapshot = {
  jobs: {
    discover: { targets: ['a', 'b'] },
    'scan-a': { findings: 1 },
    'scan-b': { findings: 2 },
  },
  groups: { 'scan-shards': ['scan-a', 'scan-b'] },
  statuses: {
    discover: 'success' as const,
    'scan-a': 'success' as const,
    'scan-b': 'failed' as const,
  },
};

describe('buildNeedsContext', () => {
  it('resolves a single-job need as { result, status }', () => {
    const needs = buildNeedsContext(snapshot, ['discover']);
    const entry = needs.discover as { result: { targets: string[] }; status: string };
    expect(entry.result.targets).toEqual(['a', 'b']);
    expect(entry.status).toBe('success');
  });

  it('resolves a group need as an ordered array of { name, result, status }', () => {
    const needs = buildNeedsContext(snapshot, [{ group: 'scan-shards' }]);
    const arr = needs['scan-shards'] as Array<{
      name: string;
      result: { findings: number };
      status: string;
    }>;
    expect(arr.map((e) => e.name)).toEqual(['scan-a', 'scan-b']);
    expect(arr.map((e) => e.result.findings)).toEqual([1, 2]);
    expect(arr.map((e) => e.status)).toEqual(['success', 'failed']);
  });

  it('defaults status to success when absent for a single-job need', () => {
    const needs = buildNeedsContext({ jobs: { a: {} }, groups: {} }, ['a']);
    expect((needs.a as { status: string }).status).toBe('success');
  });

  it('throws a clear error when a single-job need has no snapshot entry', () => {
    expect(() => {
      const n = buildNeedsContext({ jobs: {}, groups: {} }, ['missing']);
      void (n.missing as { result: Record<string, unknown> }).result.x;
    }).toThrow(/missing/);
  });
});
