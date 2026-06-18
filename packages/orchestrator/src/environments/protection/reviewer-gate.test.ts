/**
 * Tests for the reviewer gate — maps environment requiredReviewers into a
 * hold result carrying `{ user }` approver clauses.
 */
import { describe, it, expect } from 'vitest';
import type { Environment } from '@kici-dev/engine';

import { evaluateReviewerGate } from './reviewer-gate.js';

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  return {
    id: 'env-1',
    orgId: 'org-1',
    name: 'production',
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
    minimumTrust: null,
    allowLocalExecution: false,
    enabled: true,
    ...overrides,
  } as Environment;
}

describe('evaluateReviewerGate', () => {
  it('passes when no reviewers are required', () => {
    expect(evaluateReviewerGate(makeEnv()).action).toBe('pass');
    expect(evaluateReviewerGate(makeEnv({ requiredReviewers: [] })).action).toBe('pass');
  });

  it('holds with one user clause per required reviewer', () => {
    const result = evaluateReviewerGate(makeEnv({ requiredReviewers: ['alice', 'bob'] }));
    expect(result.action).toBe('hold');
    expect(result.holdType).toBe('reviewer');
    expect(result.clauses).toEqual([{ user: 'alice' }, { user: 'bob' }]);
  });
});
