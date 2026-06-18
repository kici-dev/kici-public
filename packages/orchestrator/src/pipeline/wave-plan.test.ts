import { describe, it, expect } from 'vitest';
import { VariantKind } from '@kici-dev/engine';
import type { LockJob, MaterializedJob } from '@kici-dev/engine';
import { computeWavePlan } from './dispatch-matched-workflow.js';

/** Build the N fan-out children of a base with the given wave knobs. */
function hostFanout(
  base: string,
  hosts: string[],
  knobs: { maxParallel?: number; failFast?: boolean } = {},
): MaterializedJob[] {
  const lockJob = {
    _type: 'static',
    name: base,
    runsOnAll: { include: [['role:web']], exclude: [] },
    needs: [],
    steps: [],
    ...(knobs.maxParallel !== undefined && { maxParallel: knobs.maxParallel }),
    ...(knobs.failFast !== undefined && { failFast: knobs.failFast }),
  } as LockJob;
  return hosts.map((h) => ({
    lockJob,
    baseName: base,
    expandedName: `${base} (${h})`,
    variantKind: VariantKind.host,
    host: h,
  }));
}

describe('computeWavePlan', () => {
  it('holds children beyond maxParallel, ordered by expandedName (serial = 1)', () => {
    const jobs = hostFanout('patch', ['web-01', 'web-02', 'web-03'], { maxParallel: 1 });
    const plan = computeWavePlan(jobs);
    expect([...plan.held].sort()).toEqual(['patch (web-02)', 'patch (web-03)']);
    // Every child carries the policy (held or not).
    expect(plan.policy.get('patch (web-01)')).toEqual({ maxParallel: 1, failFast: false });
    expect(plan.policy.get('patch (web-03)')).toEqual({ maxParallel: 1, failFast: false });
  });

  it('holds only children past a maxParallel:2 window', () => {
    const jobs = hostFanout('patch', ['web-01', 'web-02', 'web-03', 'web-04'], { maxParallel: 2 });
    const plan = computeWavePlan(jobs);
    expect([...plan.held].sort()).toEqual(['patch (web-03)', 'patch (web-04)']);
  });

  it('carries failFast in the policy', () => {
    const jobs = hostFanout('patch', ['web-01', 'web-02'], { maxParallel: 1, failFast: true });
    const plan = computeWavePlan(jobs);
    expect(plan.policy.get('patch (web-01)')).toEqual({ maxParallel: 1, failFast: true });
  });

  it('holds nothing when maxParallel is unset', () => {
    const jobs = hostFanout('patch', ['web-01', 'web-02', 'web-03']);
    const plan = computeWavePlan(jobs);
    expect(plan.held.size).toBe(0);
    expect(plan.policy.size).toBe(0);
  });

  it('holds nothing for a single-child (non-fan-out) job even with maxParallel', () => {
    const jobs = hostFanout('patch', ['web-01'], { maxParallel: 1 });
    const plan = computeWavePlan(jobs);
    expect(plan.held.size).toBe(0);
    expect(plan.policy.size).toBe(0);
  });

  it('is fan-out-generic: a matrix base composes the same way', () => {
    const lockJob = {
      _type: 'static',
      name: 'build',
      runsOn: 'linux',
      needs: [],
      steps: [],
      matrix: { os: ['a', 'b', 'c'] },
      maxParallel: 1,
    } as unknown as LockJob;
    const jobs: MaterializedJob[] = ['a', 'b', 'c'].map((v) => ({
      lockJob,
      baseName: 'build',
      expandedName: `build (${v})`,
      variantKind: VariantKind.matrix,
      variantValues: { os: v },
    }));
    const plan = computeWavePlan(jobs);
    expect([...plan.held].sort()).toEqual(['build (b)', 'build (c)']);
  });
});
