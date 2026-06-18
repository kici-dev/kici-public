/**
 * Tests for EventCircuitBreaker -- chain depth and per-workflow rate limiting.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { EventCircuitBreaker } from './circuit-breaker.js';
import { type EventRouterConfig, DEFAULT_EVENT_ROUTER_CONFIG } from './types.js';

describe('EventCircuitBreaker', () => {
  let config: EventRouterConfig;
  let breaker: EventCircuitBreaker;

  beforeEach(() => {
    config = {
      ...DEFAULT_EVENT_ROUTER_CONFIG,
      maxChainDepth: 10,
      rateLimitPerWorkflowPerMinute: 5,
    };
    breaker = new EventCircuitBreaker(config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkChainDepth', () => {
    it('should allow depth 0', () => {
      const result = breaker.checkChainDepth(0);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should allow depth up to maxChainDepth - 1', () => {
      for (let depth = 0; depth < 10; depth++) {
        const result = breaker.checkChainDepth(depth);
        expect(result.allowed).toBe(true);
      }
    });

    it('should reject depth equal to maxChainDepth', () => {
      const result = breaker.checkChainDepth(10);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('chain depth 10');
      expect(result.reason).toContain('maximum 10');
    });

    it('should reject depth exceeding maxChainDepth', () => {
      const result = breaker.checkChainDepth(15);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('chain depth 15');
    });

    it('should use the configured maxChainDepth', () => {
      const custom = new EventCircuitBreaker({
        ...config,
        maxChainDepth: 3,
      });

      expect(custom.checkChainDepth(2).allowed).toBe(true);
      expect(custom.checkChainDepth(3).allowed).toBe(false);
    });
  });

  describe('checkRateLimit', () => {
    it('should allow the first request', () => {
      const result = breaker.checkRateLimit('wf:ci');
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBeUndefined();
    });

    it('should allow requests up to the limit', () => {
      for (let i = 0; i < 5; i++) {
        const result = breaker.checkRateLimit('wf:ci');
        expect(result.allowed).toBe(true);
      }
    });

    it('should reject when rate limit is exceeded', () => {
      // Fill up the limit
      for (let i = 0; i < 5; i++) {
        breaker.checkRateLimit('wf:ci');
      }

      // 6th request should be rejected
      const result = breaker.checkRateLimit('wf:ci');
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('should track different workflows independently', () => {
      // Fill up one workflow
      for (let i = 0; i < 5; i++) {
        breaker.checkRateLimit('wf:ci');
      }

      // Another workflow should still be allowed
      const result = breaker.checkRateLimit('wf:deploy');
      expect(result.allowed).toBe(true);
    });

    it('should allow requests after the sliding window expires', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      // Fill up the limit
      for (let i = 0; i < 5; i++) {
        breaker.checkRateLimit('wf:ci');
      }

      // Advance time past the 60s window
      vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);

      // Should be allowed again
      const result = breaker.checkRateLimit('wf:ci');
      expect(result.allowed).toBe(true);
    });

    it('should clean expired timestamps on each check', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      // Add some requests
      for (let i = 0; i < 3; i++) {
        breaker.checkRateLimit('wf:ci');
      }

      // Advance time so the first 3 expire
      vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);

      // Should be able to add 5 more (old ones cleaned)
      for (let i = 0; i < 5; i++) {
        const result = breaker.checkRateLimit('wf:ci');
        expect(result.allowed).toBe(true);
      }

      // 6th should be rejected
      const result = breaker.checkRateLimit('wf:ci');
      expect(result.allowed).toBe(false);
    });

    it('should return retryAfterMs >= 1', () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);

      for (let i = 0; i < 5; i++) {
        breaker.checkRateLimit('wf:ci');
      }

      const result = breaker.checkRateLimit('wf:ci');
      expect(result.retryAfterMs).toBeGreaterThanOrEqual(1);
    });
  });

  describe('reset', () => {
    it('should clear all rate limit state', () => {
      // Fill up multiple workflows
      for (let i = 0; i < 5; i++) {
        breaker.checkRateLimit('wf:ci');
        breaker.checkRateLimit('wf:deploy');
      }

      // Both should be at limit
      expect(breaker.checkRateLimit('wf:ci').allowed).toBe(false);
      expect(breaker.checkRateLimit('wf:deploy').allowed).toBe(false);

      // Reset
      breaker.reset();

      // Both should be allowed again
      expect(breaker.checkRateLimit('wf:ci').allowed).toBe(true);
      expect(breaker.checkRateLimit('wf:deploy').allowed).toBe(true);
    });
  });
});
