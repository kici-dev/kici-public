import { describe, it, expect } from 'vitest';
import { deriveFailureCategory } from './agent-failure-category.js';

const base = {
  runStatus: 'failed',
  hasInitFailure: false,
  initFailureCategory: null,
  timedOut: false,
  anyStepNonZeroExit: false,
};

describe('deriveFailureCategory', () => {
  it('returns null for a successful run', () => {
    expect(deriveFailureCategory({ ...base, runStatus: 'success' })).toBeNull();
  });
  it('returns null for an in-flight run', () => {
    expect(deriveFailureCategory({ ...base, runStatus: 'running' })).toBeNull();
  });
  it('init failure wins', () => {
    expect(
      deriveFailureCategory({
        ...base,
        hasInitFailure: true,
        initFailureCategory: 'secret_resolution',
      }),
    ).toBe('init_failure');
  });
  it('no_agent init failure maps to infra', () => {
    expect(
      deriveFailureCategory({ ...base, hasInitFailure: true, initFailureCategory: 'no_agent' }),
    ).toBe('infra');
  });
  it('a timed-out job maps to timed_out', () => {
    expect(deriveFailureCategory({ ...base, timedOut: true })).toBe('timed_out');
  });
  it('cancelled status maps to cancelled', () => {
    expect(deriveFailureCategory({ ...base, runStatus: 'cancelled' })).toBe('cancelled');
  });
  it('nonzero step exit on a failed run maps to step_failed', () => {
    expect(deriveFailureCategory({ ...base, anyStepNonZeroExit: true })).toBe('step_failed');
  });
  it('failed run with no clearer signal maps to unknown', () => {
    expect(deriveFailureCategory({ ...base })).toBe('unknown');
  });
});
