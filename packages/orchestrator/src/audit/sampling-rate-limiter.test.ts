import { describe, expect, it } from 'vitest';
import { SamplingRateLimiter } from './sampling-rate-limiter.js';

describe('SamplingRateLimiter', () => {
  it('permits the first call for an action+actor pair', () => {
    const limiter = new SamplingRateLimiter(() => 0);
    expect(limiter.permit('diagnostics.read', 'user:u1', 1)).toBe(true);
  });

  it('denies subsequent calls within the per-minute window', () => {
    let now = 0;
    const limiter = new SamplingRateLimiter(() => now);
    expect(limiter.permit('diagnostics.read', 'user:u1', 1)).toBe(true);
    now = 30_000;
    expect(limiter.permit('diagnostics.read', 'user:u1', 1)).toBe(false);
    now = 59_999;
    expect(limiter.permit('diagnostics.read', 'user:u1', 1)).toBe(false);
  });

  it('permits again after the window elapses', () => {
    let now = 0;
    const limiter = new SamplingRateLimiter(() => now);
    expect(limiter.permit('diagnostics.read', 'user:u1', 1)).toBe(true);
    now = 60_000;
    expect(limiter.permit('diagnostics.read', 'user:u1', 1)).toBe(true);
  });

  it('keeps separate buckets per (action, actor) pair', () => {
    const limiter = new SamplingRateLimiter(() => 0);
    expect(limiter.permit('diagnostics.read', 'user:u1', 1)).toBe(true);
    expect(limiter.permit('diagnostics.read', 'user:u2', 1)).toBe(true);
    expect(limiter.permit('scaler.capacity.read', 'user:u1', 1)).toBe(true);
    // u1 already has diagnostics — denied.
    expect(limiter.permit('diagnostics.read', 'user:u1', 1)).toBe(false);
  });

  it('prunes stale buckets after PRUNE_TTL_MS', () => {
    let now = 0;
    const limiter = new SamplingRateLimiter(() => now);
    for (let i = 0; i < 100; i++) {
      limiter.permit('diagnostics.read', `user:u${i}`, 1);
    }
    expect(limiter.size()).toBe(100);
    // Advance past the 5-minute prune TTL and trigger another permit.
    now = 5 * 60_000 + 1;
    limiter.permit('diagnostics.read', 'user:fresh', 1);
    // All old buckets pruned; only the new one survives.
    expect(limiter.size()).toBe(1);
  });

  it('rejects perMinute <= 0', () => {
    const limiter = new SamplingRateLimiter(() => 0);
    expect(limiter.permit('diagnostics.read', 'user:u1', 0)).toBe(false);
    expect(limiter.permit('diagnostics.read', 'user:u1', -1)).toBe(false);
  });
});
