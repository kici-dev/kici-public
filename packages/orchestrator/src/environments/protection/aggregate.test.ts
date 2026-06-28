import { describe, it, expect } from 'vitest';
import type { Environment } from '@kici-dev/engine';
import {
  evaluateMultiEnvGates,
  aggregateProtectionParams,
  buildEffectiveEnvironment,
  formatMultiEnvRejection,
} from './aggregate.js';
import type { JobDispatchContext } from './pipeline.js';

function makeEnv(overrides: Partial<Environment> = {}): Environment {
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

describe('evaluateMultiEnvGates', () => {
  it('rejects when one env disallows the branch (all-must-pass)', () => {
    const envAllowMain = makeEnv({ name: 'main-only', branchRestrictions: ['main'] });
    const envAllowDevelop = makeEnv({ name: 'develop-only', branchRestrictions: ['develop'] });
    const rej = evaluateMultiEnvGates(
      [
        { name: 'main-only', env: envAllowMain },
        { name: 'develop-only', env: envAllowDevelop },
      ],
      ctx,
    );
    expect(rej).toEqual([
      {
        environment: 'develop-only',
        reason: 'branch_restricted',
        detail: expect.stringContaining('main'),
      },
    ]);
  });

  it('flags a missing environment as env_not_found', () => {
    const rej = evaluateMultiEnvGates([{ name: 'ghost', env: undefined }], ctx);
    expect(rej[0]).toMatchObject({ environment: 'ghost', reason: 'env_not_found' });
  });

  it('flags a disabled environment as env_disabled', () => {
    const rej = evaluateMultiEnvGates([{ name: 'off', env: makeEnv({ enabled: false }) }], ctx);
    expect(rej[0]).toMatchObject({ environment: 'off', reason: 'env_disabled' });
  });

  it('rejects on trigger-type and repo filters', () => {
    const triggerEnv = makeEnv({ name: 't', triggerTypeFilters: ['pull_request'] });
    const repoEnv = makeEnv({ name: 'r', repoPatterns: ['other/*'] });
    expect(evaluateMultiEnvGates([{ name: 't', env: triggerEnv }], ctx)[0]).toMatchObject({
      reason: 'trigger_filtered',
    });
    expect(evaluateMultiEnvGates([{ name: 'r', env: repoEnv }], ctx)[0]).toMatchObject({
      reason: 'repo_unmatched',
    });
  });

  it('passes when every env allows the context', () => {
    const a = makeEnv({ name: 'a', branchRestrictions: ['main'] });
    const b = makeEnv({ name: 'b' });
    expect(
      evaluateMultiEnvGates(
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

describe('buildEffectiveEnvironment', () => {
  it('neutralizes reject gates and carries aggregated holds', () => {
    const primary = makeEnv({ name: 'primary', branchRestrictions: ['main'] });
    const eff = aggregateProtectionParams([
      makeEnv({ requiredReviewers: ['a'], waitTimerSeconds: 5 }),
    ]);
    const synth = buildEffectiveEnvironment(primary, eff);
    expect(synth.branchRestrictions).toEqual([]);
    expect(synth.enabled).toBe(true);
    expect(synth.requiredReviewers).toEqual(['a']);
    expect(synth.waitTimerSeconds).toBe(5);
    expect(synth.id).toBe(primary.id);
  });
});

describe('formatMultiEnvRejection', () => {
  it('names the env and rule', () => {
    const msg = formatMultiEnvRejection([
      { environment: 'prod', reason: 'branch_restricted', detail: "branch 'main' not allowed" },
    ]);
    expect(msg).toContain("'prod'");
    expect(msg).toContain('branch_restricted');
  });
});
