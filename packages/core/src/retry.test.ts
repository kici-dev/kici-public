import { describe, it, expect } from 'vitest';
import { computeBackoffDelay, type ResolvedRetry } from './retry.js';

const cfg = (o: Partial<ResolvedRetry> = {}): ResolvedRetry => ({
  maxAttempts: 3,
  delayMs: 1000,
  backoff: 'exponential',
  maxDelayMs: 30000,
  ...o,
});

describe('computeBackoffDelay', () => {
  it('exponential grows by 2^(n-1)', () => {
    expect(computeBackoffDelay(1, cfg())).toBe(1000);
    expect(computeBackoffDelay(2, cfg())).toBe(2000);
    expect(computeBackoffDelay(3, cfg())).toBe(4000);
  });
  it('exponential caps at maxDelayMs', () => {
    expect(computeBackoffDelay(10, cfg({ delayMs: 1000, maxDelayMs: 5000 }))).toBe(5000);
  });
  it('fixed is constant', () => {
    expect(computeBackoffDelay(5, cfg({ backoff: 'fixed' }))).toBe(1000);
  });
});
