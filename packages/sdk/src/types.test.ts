import { describe, it, expect } from 'vitest';
import { dynamicJob, getDynamicJobGroup, getDynamicJobNeeds, job, dynamicGroup } from './index.js';

describe('result-aware dynamicJob', () => {
  it('event-only function form has a group tag and no needs', () => {
    const fn = dynamicJob('shards', async () => []);
    expect(getDynamicJobGroup(fn)).toBe('shards');
    expect(getDynamicJobNeeds(fn)).toBeUndefined();
  });

  it('options form carries declared needs and the group tag', () => {
    const fn = dynamicJob('reports', {
      needs: ['discover', dynamicGroup('scan-shards')],
      generate: async () => [],
    });
    expect(getDynamicJobGroup(fn)).toBe('reports');
    const needs = getDynamicJobNeeds(fn);
    expect(needs).toBeDefined();
    expect(needs).toHaveLength(2);
    // first edge: a plain static-job name
    expect(needs![0]).toBe('discover');
    // second edge: a dynamic group ref
    expect(needs![1]).toMatchObject({ group: 'scan-shards' });
  });

  it('options form invokes generate as the underlying DynamicJobFn', async () => {
    const fn = dynamicJob('reports', {
      needs: ['discover'],
      generate: async () => [job('r', { runsOn: 'linux', run: async () => {} })],
    });
    const out = await (fn as unknown as (c: unknown) => Promise<unknown[]>)({
      ctx: { workflow: { name: 'w' } },
    });
    expect(out).toHaveLength(1);
  });
});
