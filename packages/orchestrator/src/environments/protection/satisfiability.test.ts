import { describe, it, expect } from 'vitest';
import type { Environment } from '@kici-dev/engine';
import { checkBindingSatisfiable } from './satisfiability.js';

function env(name: string, over: Partial<Environment> = {}): Environment {
  return {
    id: `id-${name}`,
    orgId: 'org-1',
    name,
    type: 'fixed',
    globPattern: null,
    branchRestrictions: [],
    triggerTypeFilters: [],
    repoPatterns: [],
    concurrencyLimit: null,
    concurrencyStrategy: 'queue',
    concurrencyTimeoutMs: 0,
    requiredReviewers: null,
    waitTimerSeconds: null,
    holdExpirySeconds: 3600,
    enabled: true,
    createdAt: '',
    updatedAt: '',
    createdBy: '',
    ...over,
  };
}

describe('checkBindingSatisfiable', () => {
  it('flags disjoint fixed branch restrictions', () => {
    const r = checkBindingSatisfiable(
      'deploy',
      [
        env('staging', { branchRestrictions: ['main'] }),
        env('testing', { branchRestrictions: ['develop'] }),
      ],
      ['staging', 'testing'],
    );
    expect(r?.rule).toBe('branch');
    expect(r?.message).toContain('mutually exclusive');
  });

  it('treats a missing environment as satisfiable (lenient, matches dispatch)', () => {
    // A bound name with no resolved record contributes no protection rules and
    // is skipped at dispatch (dispatch-matched-workflow.ts), so registration
    // must not reject it. Single present env + one missing → satisfiable.
    const r = checkBindingSatisfiable(
      'deploy',
      [env('staging', { branchRestrictions: ['main'] }), undefined],
      ['staging', 'ghost'],
    );
    expect(r).toBeNull();
  });

  it('treats a single bound missing environment as satisfiable', () => {
    // The exact E2E shape: a job binds one static env the orchestrator never
    // seeded → no record → lenient (the dispatch gate handles it at run time).
    const r = checkBindingSatisfiable('deploy', [undefined], ['production']);
    expect(r).toBeNull();
  });

  it('ignores missing envs but still flags a real conflict among present ones', () => {
    // One missing env must not suppress a genuine multi-env conflict between the
    // environments that DO resolve.
    const r = checkBindingSatisfiable(
      'deploy',
      [
        undefined,
        env('staging', { branchRestrictions: ['main'] }),
        env('testing', { branchRestrictions: ['develop'] }),
      ],
      ['ghost', 'staging', 'testing'],
    );
    expect(r?.rule).toBe('branch');
    expect(r?.message).toContain('mutually exclusive');
  });

  it('flags a disabled environment', () => {
    const r = checkBindingSatisfiable(
      'deploy',
      [env('staging'), env('testing', { enabled: false })],
      ['staging', 'testing'],
    );
    expect(r?.rule).toBe('enabled');
    expect(r?.message).toContain('testing');
  });

  it('flags a single bound disabled environment (matches dispatch hard-reject)', () => {
    // A present-but-disabled env is a dispatch-time hard reject (env_disabled),
    // so registration rejects it even as the sole binding. Deliberate decision:
    // disabled (present) state is rejected; missing (absent) state is lenient.
    const r = checkBindingSatisfiable('deploy', [env('staging', { enabled: false })], ['staging']);
    expect(r?.rule).toBe('enabled');
    expect(r?.message).toContain('staging');
  });

  it('flags disjoint fixed trigger filters', () => {
    const r = checkBindingSatisfiable(
      'deploy',
      [env('a', { triggerTypeFilters: ['push'] }), env('b', { triggerTypeFilters: ['pr:open'] })],
      ['a', 'b'],
    );
    expect(r?.rule).toBe('trigger');
  });

  it('returns null for satisfiable bindings (overlapping branch sets)', () => {
    expect(
      checkBindingSatisfiable(
        'deploy',
        [
          env('a', { branchRestrictions: ['main', 'develop'] }),
          env('b', { branchRestrictions: ['develop'] }),
        ],
        ['a', 'b'],
      ),
    ).toBeNull();
  });

  it('returns null when one environment has no branch constraint', () => {
    expect(
      checkBindingSatisfiable(
        'deploy',
        [env('a', { branchRestrictions: ['main'] }), env('b')],
        ['a', 'b'],
      ),
    ).toBeNull();
  });

  it('returns null (defers) when restrictions are glob/undecidable', () => {
    expect(
      checkBindingSatisfiable(
        'deploy',
        [
          env('a', { branchRestrictions: ['release/*'] }),
          env('b', { branchRestrictions: ['main'] }),
        ],
        ['a', 'b'],
      ),
    ).toBeNull();
  });

  it('returns null for a single bound environment', () => {
    expect(
      checkBindingSatisfiable('deploy', [env('a', { branchRestrictions: ['main'] })], ['a']),
    ).toBeNull();
  });
});
