import { describe, it, expect } from 'vitest';
import type { Context } from '@kici-dev/engine';
import {
  evaluateMultiContextGates,
  aggregateProtectionParams,
  buildEffectiveContext,
  formatMultiContextRejection,
} from './aggregate.js';
import type { JobDispatchContext } from './pipeline.js';

function makeEnv(overrides: Partial<Context> = {}): Context {
  return {
    id: 'env-1',
    orgId: 'org-1',
    name: 'env',
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
    ...overrides,
  };
}

const ctx: JobDispatchContext = {
  branch: 'main',
  triggerType: 'push',
  repository: 'o/r',
  runId: 'r1',
  jobId: 'j1',
};

describe('evaluateMultiContextGates', () => {
  it('rejects when one env disallows the branch (all-must-pass)', () => {
    const envAllowMain = makeEnv({ name: 'main-only', branchRestrictions: ['main'] });
    const envAllowDevelop = makeEnv({ name: 'develop-only', branchRestrictions: ['develop'] });
    const rej = evaluateMultiContextGates(
      [
        { name: 'main-only', env: envAllowMain },
        { name: 'develop-only', env: envAllowDevelop },
      ],
      ctx,
    );
    expect(rej).toEqual([
      {
        context: 'develop-only',
        reason: 'branch_restricted',
        detail: expect.stringContaining('main'),
      },
    ]);
  });

  it('flags a missing context as context_not_found', () => {
    const rej = evaluateMultiContextGates([{ name: 'ghost', env: undefined }], ctx);
    expect(rej[0]).toMatchObject({ context: 'ghost', reason: 'context_not_found' });
  });

  it('flags a disabled context as context_disabled', () => {
    const rej = evaluateMultiContextGates([{ name: 'off', env: makeEnv({ enabled: false }) }], ctx);
    expect(rej[0]).toMatchObject({ context: 'off', reason: 'context_disabled' });
  });

  it('rejects on trigger-type and repo filters', () => {
    const triggerEnv = makeEnv({ name: 't', triggerTypeFilters: ['pull_request'] });
    const repoEnv = makeEnv({ name: 'r', repoPatterns: ['other/*'] });
    expect(evaluateMultiContextGates([{ name: 't', env: triggerEnv }], ctx)[0]).toMatchObject({
      reason: 'trigger_filtered',
    });
    expect(evaluateMultiContextGates([{ name: 'r', env: repoEnv }], ctx)[0]).toMatchObject({
      reason: 'repo_unmatched',
    });
  });

  it('passes when every env allows the context', () => {
    const a = makeEnv({ name: 'a', branchRestrictions: ['main'] });
    const b = makeEnv({ name: 'b' });
    expect(
      evaluateMultiContextGates(
        [
          { name: 'a', env: a },
          { name: 'b', env: b },
        ],
        ctx,
      ),
    ).toEqual([]);
  });
});

describe('aggregateProtectionParams', () => {
  it('aggregates trust=max, reviewers=union, waitTimer=max, holdExpiry=min, concurrency=min', () => {
    const envA = makeEnv({
      minimumTrust: 'known',
      requiredReviewers: ['a', 'b'],
      waitTimerSeconds: 10,
      holdExpirySeconds: 7200,
      concurrencyLimit: 5,
    });
    const envB = makeEnv({
      minimumTrust: 'trusted',
      requiredReviewers: ['b', 'c'],
      waitTimerSeconds: 30,
      holdExpirySeconds: 1800,
      concurrencyLimit: 2,
    });
    const eff = aggregateProtectionParams([envA, envB]);
    expect(eff.minimumTrust).toBe('trusted');
    expect(eff.requiredReviewers).toEqual(['a', 'b', 'c']);
    expect(eff.waitTimerSeconds).toBe(30);
    expect(eff.holdExpirySeconds).toBe(1800);
    expect(eff.concurrencyLimit).toBe(2);
  });

  it('leaves null fields null when no env sets them', () => {
    const eff = aggregateProtectionParams([makeEnv(), makeEnv()]);
    expect(eff.minimumTrust).toBeUndefined();
    expect(eff.requiredReviewers).toEqual([]);
    expect(eff.waitTimerSeconds).toBeNull();
    expect(eff.concurrencyLimit).toBeNull();
  });
});

describe('buildEffectiveContext', () => {
  it('neutralizes reject gates and carries aggregated holds', () => {
    const primary = makeEnv({ name: 'primary', branchRestrictions: ['main'] });
    const eff = aggregateProtectionParams([
      makeEnv({ requiredReviewers: ['a'], waitTimerSeconds: 5 }),
    ]);
    const synth = buildEffectiveContext(primary, eff);
    expect(synth.branchRestrictions).toEqual([]);
    expect(synth.enabled).toBe(true);
    expect(synth.requiredReviewers).toEqual(['a']);
    expect(synth.waitTimerSeconds).toBe(5);
    expect(synth.id).toBe(primary.id);
  });
});

describe('evaluateMultiContextGates — internally-triggered runs', () => {
  it('accepts a run whose inherited branch matches the restriction', () => {
    // The setup the docs present as canonical: a nightly deploy bound to a
    // context restricted to the default branch.
    const env = makeEnv({ name: 'production', branchRestrictions: ['main'] });
    expect(
      evaluateMultiContextGates([{ name: 'production', env }], {
        ...ctx,
        branch: 'main',
        internallyTriggered: true,
      }),
    ).toEqual([]);
  });

  it('names the real branch when an internally-triggered run does not match', () => {
    const env = makeEnv({ name: 'production', branchRestrictions: ['release/*'] });
    const rej = evaluateMultiContextGates([{ name: 'production', env }], {
      ...ctx,
      branch: 'main',
      internallyTriggered: true,
    });
    expect(rej).toHaveLength(1);
    expect(rej[0].reason).toBe('branch_restricted');
    expect(rej[0].detail).toContain("branch 'main' not allowed");
  });

  it('names the missing branch when the run carries none', () => {
    const env = makeEnv({ name: 'production', branchRestrictions: ['main'] });
    const rej = evaluateMultiContextGates([{ name: 'production', env }], {
      ...ctx,
      branch: '',
      internallyTriggered: true,
    });
    expect(rej).toHaveLength(1);
    expect(rej[0].reason).toBe('branch_restricted');
    expect(rej[0].detail).toContain('carries no branch');
    // The context name is added by the formatter, so the detail must not
    // duplicate it.
    expect(rej[0].detail).not.toContain('production');
  });

  it('still rejects a branchless run against a catch-all pattern', () => {
    // `*` matches any branch NAME; a run with no branch has nothing to match,
    // so the named-cause verdict stands rather than letting it through.
    const env = makeEnv({ name: 'anything', branchRestrictions: ['*'] });
    expect(
      evaluateMultiContextGates([{ name: 'anything', env }], { ...ctx, branch: 'main' }),
    ).toEqual([]);
    const rej = evaluateMultiContextGates([{ name: 'anything', env }], {
      ...ctx,
      branch: '',
      internallyTriggered: true,
    });
    expect(rej).toHaveLength(1);
    expect(rej[0].reason).toBe('branch_restricted');
    expect(rej[0].detail).toContain('carries no branch');
  });

  it('leaves a context with no branch restriction passing', () => {
    // The documented remedy: the same internally-triggered run against a
    // context that restricts by trigger type instead.
    const env = makeEnv({ name: 'nightly', triggerTypeFilters: ['schedule'] });
    expect(
      evaluateMultiContextGates([{ name: 'nightly', env }], {
        ...ctx,
        branch: '',
        triggerType: 'schedule',
        internallyTriggered: true,
      }),
    ).toEqual([]);
  });
});

describe('formatMultiContextRejection', () => {
  it('names the env and rule', () => {
    const msg = formatMultiContextRejection([
      { context: 'prod', reason: 'branch_restricted', detail: "branch 'main' not allowed" },
    ]);
    expect(msg).toContain("'prod'");
    expect(msg).toContain('branch_restricted');
  });
});
