import { describe, expect, it } from 'vitest';
import { DEFAULT_HOLD_EXPIRY_SECONDS } from './hold-expiry.js';

describe('DEFAULT_HOLD_EXPIRY_SECONDS', () => {
  it('is one hour, the value the operator docs and every read-side fallback state', () => {
    expect(DEFAULT_HOLD_EXPIRY_SECONDS).toBe(3600);
  });

  it('is a positive integer, so a hold resolved through it is never already overdue', () => {
    // `evaluateReviewerGate` computes `holdUntil` as `now + value * 1000`, so a
    // zero or negative default would put every hold in the past and the stale
    // detector would sweep it to `expired` before a reviewer could act.
    expect(Number.isInteger(DEFAULT_HOLD_EXPIRY_SECONDS)).toBe(true);
    expect(DEFAULT_HOLD_EXPIRY_SECONDS).toBeGreaterThan(0);
  });
});
