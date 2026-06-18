/**
 * Tests for protection gate pipeline and individual gates.
 *
 * Each gate is a pure function. The pipeline evaluates gates in order:
 * branch -> trust -> concurrency -> reviewer -> timer.
 * First non-pass result stops evaluation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { evaluateProtectionRules, type JobDispatchContext } from './pipeline.js';
import { evaluateBranchGate } from './branch-gate.js';
import { evaluateConcurrencyGate } from './concurrency-gate.js';
import { evaluateReviewerGate } from './reviewer-gate.js';
import { evaluateTrustGate } from './trust-gate.js';
import { evaluateWaitTimerGate } from './wait-timer-gate.js';
import type { Environment } from '@kici-dev/engine';

// ── Fixtures ──────────────────────────────────────────────────────

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  return {
    id: 'env-001',
    orgId: 'org-abc',
    name: 'production',
    type: 'fixed',
    globPattern: null,
    branchRestrictions: [],
    triggerTypeFilters: [],
    repoPatterns: [],
    concurrencyLimit: null,
    concurrencyStrategy: 'queue',
    concurrencyTimeoutMs: 1800000,
    requiredReviewers: null,
    waitTimerSeconds: null,
    holdExpirySeconds: 86400,
    enabled: true,
    createdAt: '2026-03-08T10:00:00Z',
    updatedAt: '2026-03-08T10:00:00Z',
    createdBy: 'user:admin',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<JobDispatchContext> = {}): JobDispatchContext {
  return {
    branch: 'main',
    triggerType: 'push',
    repository: 'owner/repo',
    runId: 'run-001',
    jobId: 'job-001',
    ...overrides,
  };
}

// ── Branch gate tests ─────────────────────────────────────────────

describe('evaluateBranchGate', () => {
  it('should pass when no branch restrictions', () => {
    const result = evaluateBranchGate(makeEnv(), makeCtx());
    expect(result.action).toBe('pass');
  });

  it('should pass when branch matches restriction pattern', () => {
    const env = makeEnv({ branchRestrictions: ['main', 'release/*'] });
    const result = evaluateBranchGate(env, makeCtx({ branch: 'main' }));
    expect(result.action).toBe('pass');
  });

  it('should pass when branch matches glob pattern', () => {
    const env = makeEnv({ branchRestrictions: ['release/*'] });
    const result = evaluateBranchGate(env, makeCtx({ branch: 'release/v1.0' }));
    expect(result.action).toBe('pass');
  });

  it('should reject when branch does not match any restriction', () => {
    const env = makeEnv({ branchRestrictions: ['main', 'release/*'] });
    const result = evaluateBranchGate(env, makeCtx({ branch: 'feature/xyz' }));
    expect(result.action).toBe('reject');
    expect(result.reason).toContain('feature/xyz');
    expect(result.reason).toContain('production');
  });

  it('should pass when no trigger type filters', () => {
    const result = evaluateBranchGate(makeEnv(), makeCtx({ triggerType: 'pull_request' }));
    expect(result.action).toBe('pass');
  });

  it('should reject when trigger type does not match filters', () => {
    const env = makeEnv({ triggerTypeFilters: ['push'] });
    const result = evaluateBranchGate(env, makeCtx({ triggerType: 'pull_request' }));
    expect(result.action).toBe('reject');
    expect(result.reason).toContain('pull_request');
  });

  it('should pass when trigger type matches filters', () => {
    const env = makeEnv({ triggerTypeFilters: ['push', 'pull_request'] });
    const result = evaluateBranchGate(env, makeCtx({ triggerType: 'push' }));
    expect(result.action).toBe('pass');
  });

  it('should reject when repo does not match patterns', () => {
    const env = makeEnv({ repoPatterns: ['org/frontend-*'] });
    const result = evaluateBranchGate(env, makeCtx({ repository: 'org/backend-api' }));
    expect(result.action).toBe('reject');
    expect(result.reason).toContain('org/backend-api');
  });

  it('should pass when repo matches patterns', () => {
    const env = makeEnv({ repoPatterns: ['org/frontend-*'] });
    const result = evaluateBranchGate(env, makeCtx({ repository: 'org/frontend-web' }));
    expect(result.action).toBe('pass');
  });
});

// ── Concurrency gate tests ────────────────────────────────────────

describe('evaluateConcurrencyGate', () => {
  it('should pass when concurrency limit is null (unlimited)', () => {
    const env = makeEnv({ concurrencyLimit: null });
    const result = evaluateConcurrencyGate(env, 5, 'group-1');
    expect(result.action).toBe('pass');
  });

  it('should pass when running count is below limit', () => {
    const env = makeEnv({ concurrencyLimit: 3 });
    const result = evaluateConcurrencyGate(env, 2, 'group-1');
    expect(result.action).toBe('pass');
  });

  it('should queue when running count equals limit with queue strategy', () => {
    const env = makeEnv({ concurrencyLimit: 2, concurrencyStrategy: 'queue' });
    const result = evaluateConcurrencyGate(env, 2, 'group-1');
    expect(result.action).toBe('queue');
    expect(result.reason).toContain('Concurrency limit reached');
  });

  it('should queue when running count exceeds limit', () => {
    const env = makeEnv({ concurrencyLimit: 1 });
    const result = evaluateConcurrencyGate(env, 3, 'group-1');
    expect(result.action).toBe('queue');
  });

  it('should return cancel-pending queue action with cancel-pending strategy', () => {
    const env = makeEnv({ concurrencyLimit: 1, concurrencyStrategy: 'cancel-pending' });
    const result = evaluateConcurrencyGate(env, 1, 'group-1');
    expect(result.action).toBe('queue');
    expect(result.reason).toBe('cancel-pending');
  });
});

// ── Reviewer gate tests ───────────────────────────────────────────

describe('evaluateReviewerGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should pass when no required reviewers', () => {
    const result = evaluateReviewerGate(makeEnv({ requiredReviewers: null }));
    expect(result.action).toBe('pass');
  });

  it('should pass when required reviewers is empty array', () => {
    const result = evaluateReviewerGate(makeEnv({ requiredReviewers: [] }));
    expect(result.action).toBe('pass');
  });

  it('should hold when reviewers are required', () => {
    const env = makeEnv({
      requiredReviewers: ['user:alice', 'user:bob'],
      holdExpirySeconds: 3600,
    });
    const result = evaluateReviewerGate(env);
    expect(result.action).toBe('hold');
    expect(result.holdType).toBe('reviewer');
    expect(result.holdUntil).toBe('2026-03-08T13:00:00.000Z');
  });
});

// ── Wait timer gate tests ─────────────────────────────────────────

describe('evaluateWaitTimerGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should pass when no wait timer configured', () => {
    const result = evaluateWaitTimerGate(makeEnv({ waitTimerSeconds: null }));
    expect(result.action).toBe('pass');
  });

  it('should wait when wait timer is configured', () => {
    const env = makeEnv({ waitTimerSeconds: 300 });
    const result = evaluateWaitTimerGate(env);
    expect(result.action).toBe('wait');
    expect(result.holdType).toBe('timer');
    expect(result.holdUntil).toBe('2026-03-08T12:05:00.000Z');
  });
});

// ── Pipeline tests ────────────────────────────────────────────────

describe('evaluateProtectionRules', () => {
  it('should reject when environment is disabled', async () => {
    const env = makeEnv({ enabled: false });
    const result = await evaluateProtectionRules(env, makeCtx(), 0, 'group-1');
    expect(result.action).toBe('reject');
    expect(result.reason).toContain('disabled');
  });

  it('should pass when no protection rules configured', async () => {
    const result = await evaluateProtectionRules(makeEnv(), makeCtx(), 0, 'group-1');
    expect(result.action).toBe('pass');
  });

  it('should stop at first non-pass gate (branch rejects)', async () => {
    const env = makeEnv({
      branchRestrictions: ['main'],
      requiredReviewers: ['user:alice'],
    });
    const result = await evaluateProtectionRules(env, makeCtx({ branch: 'develop' }), 0, 'group-1');
    expect(result.action).toBe('reject');
    expect(result.reason).toContain('develop');
  });

  it('should evaluate concurrency after branch passes', async () => {
    const env = makeEnv({
      branchRestrictions: ['main'],
      concurrencyLimit: 1,
    });
    const result = await evaluateProtectionRules(env, makeCtx({ branch: 'main' }), 1, 'group-1');
    expect(result.action).toBe('queue');
  });

  it('should evaluate reviewer after concurrency passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));
    try {
      const env = makeEnv({
        concurrencyLimit: 5,
        requiredReviewers: ['user:alice'],
        holdExpirySeconds: 3600,
      });
      const result = await evaluateProtectionRules(env, makeCtx(), 0, 'group-1');
      expect(result.action).toBe('hold');
      expect(result.holdType).toBe('reviewer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should evaluate wait timer after reviewer passes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));
    try {
      const env = makeEnv({ waitTimerSeconds: 60 });
      const result = await evaluateProtectionRules(env, makeCtx(), 0, 'group-1');
      expect(result.action).toBe('wait');
      expect(result.holdType).toBe('timer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should evaluate gates in order: branch -> trust -> concurrency -> reviewer -> timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T12:00:00Z'));
    try {
      // All gates configured, all should pass except timer (last)
      const env = makeEnv({
        branchRestrictions: ['main'],
        concurrencyLimit: 10,
        waitTimerSeconds: 120,
      });
      const result = await evaluateProtectionRules(env, makeCtx({ branch: 'main' }), 0, 'group-1');
      // Timer is evaluated last, so we get wait
      expect(result.action).toBe('wait');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should pass trustTier through to trust gate', async () => {
    const env = makeEnv({ minimumTrust: 'trusted' });
    const result = await evaluateProtectionRules(
      env,
      makeCtx(),
      0,
      'group-1',
      'known', // known contributor, but environment requires trusted
    );
    expect(result.action).toBe('hold');
    expect(result.holdType).toBe('security');
    expect(result.reason).toContain('trusted contributors');
  });

  it('should hold for trust gate after branch passes but before reviewer', async () => {
    const env = makeEnv({
      branchRestrictions: ['main'],
      minimumTrust: 'known',
      requiredReviewers: ['user:alice'],
    });
    // Branch passes (main matches), trust gate holds (unknown contributor)
    const result = await evaluateProtectionRules(
      env,
      makeCtx({ branch: 'main' }),
      0,
      'group-1',
      'unknown',
    );
    expect(result.action).toBe('hold');
    expect(result.holdType).toBe('security');
    // Reviewer gate should NOT be reached
    expect(result.reason).toContain('known contributors');
  });

  it('should skip trust gate when no trustTier provided', async () => {
    const env = makeEnv({ minimumTrust: 'trusted' });
    const result = await evaluateProtectionRules(env, makeCtx(), 0, 'group-1');
    // No trustTier = pass through trust gate (push event)
    expect(result.action).toBe('pass');
  });

  it('should pass trust gate when contributor meets minimum trust', async () => {
    const env = makeEnv({ minimumTrust: 'known' });
    const result = await evaluateProtectionRules(env, makeCtx(), 0, 'group-1', 'trusted');
    expect(result.action).toBe('pass');
  });
});
