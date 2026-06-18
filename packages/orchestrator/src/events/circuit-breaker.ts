import { SlidingWindowRateLimiter } from '../helpers/rate-limiter.js';
import type { EventRouterConfig } from './types.js';

/**
 * Circuit breaker for event loop detection and per-workflow rate limiting.
 *
 * Two-layer protection:
 * 1. Chain depth: Rejects events exceeding configurable max chain depth.
 * 2. Rate limiting: Sliding-window per-workflow rate limiter.
 */
export class EventCircuitBreaker {
  private rateLimiter: SlidingWindowRateLimiter;

  constructor(private readonly config: EventRouterConfig) {
    this.rateLimiter = new SlidingWindowRateLimiter(config.rateLimitPerWorkflowPerMinute);
  }

  /**
   * Check if the current chain depth is within limits.
   */
  checkChainDepth(currentDepth: number): { allowed: boolean; reason?: string } {
    if (currentDepth >= this.config.maxChainDepth) {
      return {
        allowed: false,
        reason: `Event chain depth ${currentDepth} exceeds maximum ${this.config.maxChainDepth}`,
      };
    }
    return { allowed: true };
  }

  /**
   * Check if a workflow is within its per-minute rate limit.
   * Uses a sliding window of 60 seconds.
   */
  checkRateLimit(workflowKey: string): { allowed: boolean; retryAfterMs?: number } {
    return this.rateLimiter.check(workflowKey);
  }

  /**
   * Clear all rate limit state (for testing).
   */
  reset(): void {
    this.rateLimiter.reset();
  }
}
