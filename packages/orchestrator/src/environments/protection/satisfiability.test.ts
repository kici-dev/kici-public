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

  it('flags a missing environment', () => {
    const r = checkBindingSatisfiable(
      'deploy',
      [env('staging', { branchRestrictions: ['main'] }), undefined],
      ['staging', 'ghost'],
    );
    expect(r?.rule).toBe('existence');
    expect(r?.message).toContain('ghost');
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
