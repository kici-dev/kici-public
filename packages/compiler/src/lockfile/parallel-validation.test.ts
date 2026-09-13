import { describe, it, expect } from 'vitest';
import { transformSteps } from './generator.js';
import { parallel, step } from '@kici-dev/sdk';
import type { LockParallelStep, LockStep } from '../types.js';

const s = (n: string) => step(n, { run: async () => {} });

describe('transformSteps — parallel', () => {
  it('emits a parallel lock entry with sequential children', () => {
    const out = transformSteps([s('checkout'), parallel([s('lint'), s('tc')])], '/repo');
    expect((out[0] as LockStep).kind ?? 'sequential').toBe('sequential');
    expect((out[1] as LockParallelStep).kind).toBe('parallel');
    expect((out[1] as LockParallelStep).children.map((c) => c.name)).toEqual(['lint', 'tc']);
    expect((out[1] as LockParallelStep).failFast).toBe(true);
  });

  it('carries explicit failFast/maxParallel/name onto the lock entry', () => {
    const out = transformSteps(
      [parallel([s('a'), s('b')], { failFast: false, maxParallel: 2, name: 'checks' })],
      '/repo',
    );
    const g = out[0] as LockParallelStep;
    expect(g.name).toBe('checks');
    expect(g.failFast).toBe(false);
    expect(g.maxParallel).toBe(2);
  });

  it('assigns flat step-N names across sequential + parallel children inline', () => {
    const out = transformSteps(
      [step(async () => {}), parallel([step(async () => {}), step(async () => {})])],
      '/repo',
    );
    expect((out[0] as LockStep).name).toBe('step-1');
    const g = out[1] as LockParallelStep;
    expect(g.children.map((c) => c.name)).toEqual(['step-2', 'step-3']);
  });

  it('rejects an empty group', () => {
    expect(() => transformSteps([parallel([])], '/repo')).toThrow(/empty parallel/i);
  });

  it('rejects duplicate child names', () => {
    expect(() => transformSteps([parallel([s('dup'), s('dup')])], '/repo')).toThrow(/duplicate/i);
  });

  it('rejects nested parallel', () => {
    expect(() => transformSteps([parallel([parallel([s('a')]) as never])], '/repo')).toThrow(
      /nest/i,
    );
  });
});
