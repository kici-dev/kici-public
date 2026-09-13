import { describe, it, expect } from 'vitest';
import { parallel, isParallelGroup } from './parallel.js';
import { step } from './step.js';

const s = (n: string) => step(n, { run: async () => {} });

describe('parallel()', () => {
  it('builds a ParallelGroup with failFast defaulting true', () => {
    const g = parallel([s('a'), s('b')]);
    expect(g._tag).toBe('ParallelGroup');
    expect(g.failFast).toBe(true);
    expect(g.maxParallel).toBeUndefined();
    expect(g.steps).toHaveLength(2);
    expect(isParallelGroup(g)).toBe(true);
    expect(isParallelGroup(s('a'))).toBe(false);
  });

  it('honors explicit opts', () => {
    const g = parallel([s('a')], { failFast: false, maxParallel: 3, name: 'checks' });
    expect(g.failFast).toBe(false);
    expect(g.maxParallel).toBe(3);
    expect(g.name).toBe('checks');
  });

  it('isParallelGroup rejects non-group values', () => {
    expect(isParallelGroup(null)).toBe(false);
    expect(isParallelGroup(undefined)).toBe(false);
    expect(isParallelGroup({})).toBe(false);
    expect(isParallelGroup(() => {})).toBe(false);
  });
});
