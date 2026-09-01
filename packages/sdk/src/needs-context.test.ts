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

  it('resolves an invoke-gate need as { result } — an ordered array of InvokeResult', () => {
    const gateSnapshot = {
      jobs: {},
      groups: {},
      invokeResults: {
        'repo-tests': [
          {
            repo: 'myorg/backend',
            workflow: 'repo-tests',
            runId: 'r1',
            status: 'success',
            outputs: { coverage: '92' },
          },
          {
            repo: 'myorg/backend',
            workflow: 'repo-lint',
            runId: 'r2',
            status: 'failed',
            outputs: {},
          },
        ],
      },
    };
    const needs = buildNeedsContext(gateSnapshot, ['repo-tests']);
    const entry = needs['repo-tests'] as {
      result: Array<{
        repo: string;
        workflow: string;
        runId: string;
        status: string;
        outputs: Record<string, unknown>;
      }>;
    };
    const arr = entry.result;
    expect(arr.map((e) => e.runId)).toEqual(['r1', 'r2']);
    expect(arr.map((e) => e.repo)).toEqual(['myorg/backend', 'myorg/backend']);
    expect(arr.map((e) => e.workflow)).toEqual(['repo-tests', 'repo-lint']);
    expect(arr.map((e) => e.status)).toEqual(['success', 'failed']);
    expect(arr[0].outputs.coverage).toBe('92');
  });

  it('throws a clear error when a single-job need has no snapshot entry', () => {
    expect(() => {
      const n = buildNeedsContext({ jobs: {}, groups: {} }, ['missing']);
      void (n.missing as { result: Record<string, unknown> }).result.x;
    }).toThrow(/missing/);
  });
});
