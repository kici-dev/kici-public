import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlidingWindowRateLimiter } from './rate-limiter.js';

describe('SlidingWindowRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('rate-limit behavior (unchanged contract)', () => {
    it('allows up to the max within the window and blocks the next', () => {
      const limiter = new SlidingWindowRateLimiter(2, 60_000);
      expect(limiter.check('a').allowed).toBe(true);
      expect(limiter.check('a').allowed).toBe(true);
      const blocked = limiter.check('a');
      expect(blocked.allowed).toBe(false);
      // Oldest of the two in-window timestamps is at t=0; retry after full window.
      expect(blocked.retryAfterMs).toBe(60_000);
    });

    it('allows again once the window slides past the recorded timestamps', () => {
      const limiter = new SlidingWindowRateLimiter(1, 60_000);
      expect(limiter.check('a').allowed).toBe(true);
      expect(limiter.check('a').allowed).toBe(false);
      vi.advanceTimersByTime(60_001);
      expect(limiter.check('a').allowed).toBe(true);
    });

    it('keeps per-key isolation (one key hitting its limit does not block another)', () => {
      const limiter = new SlidingWindowRateLimiter(1, 60_000);
      expect(limiter.check('a').allowed).toBe(true);
      expect(limiter.check('a').allowed).toBe(false);
      expect(limiter.check('b').allowed).toBe(true);
    });
  });

  describe('idle-key eviction (map stays bounded)', () => {
    it('does not retain a bucket for a max<=0 (block-all) key and does not crash', () => {
      const limiter = new SlidingWindowRateLimiter(0, 60_000);
      const res = limiter.check('src-1', 0);
      expect(res.allowed).toBe(false);
      // Blocked with no timestamp recorded and no oldest to derive from:
      // retry falls back to the full window rather than NaN.
      expect(res.retryAfterMs).toBe(60_000);
      // Nothing was recorded, so nothing is retained.
      expect(limiter.size).toBe(0);
    });

    it('shrinks the map after keys go idle and a later check triggers the sweep', () => {
      const limiter = new SlidingWindowRateLimiter(5, 60_000);
      // Touch 100 distinct keys within the window.
      for (let i = 0; i < 100; i++) {
        expect(limiter.check(`event-${i}`).allowed).toBe(true);
      }
      expect(limiter.size).toBe(100);

      // Let every bucket age out of the window, then issue one more check.
      // The amortized sweep (>= windowMs since the last one) reclaims the
      // 100 idle buckets; only the freshly-recorded active key remains.
      vi.advanceTimersByTime(60_001);
      expect(limiter.check('event-fresh').allowed).toBe(true);
      expect(limiter.size).toBe(1);
    });

    it('reclaims a re-checked key whose window expired without unbounded growth', () => {
      const limiter = new SlidingWindowRateLimiter(3, 60_000);
      limiter.check('a');
      limiter.check('a');
      expect(limiter.size).toBe(1);
      vi.advanceTimersByTime(60_001);
      // Re-checking after full expiry keeps exactly one active bucket for 'a'
      // (old timestamps dropped, one fresh timestamp recorded) — never a
      // second, stale, empty bucket.
      expect(limiter.check('a').allowed).toBe(true);
      expect(limiter.size).toBe(1);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const limiter = new SlidingWindowRateLimiter(1, 60_000);
      limiter.check('a');
      expect(limiter.size).toBe(1);
      limiter.reset();
      expect(limiter.size).toBe(0);
    });
  });
});
