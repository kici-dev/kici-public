import { SlidingWindowRateLimiter } from '../helpers/rate-limiter.js';
import type { EventRouterConfig } from './types.js';

/**
 * Circuit breaker for event loop detection and user-event rate limiting.
 *
 * Two-layer protection:
 * 1. Chain depth: Rejects events exceeding configurable max chain depth.
 * 2. Rate limiting: Sliding-window limiter keyed per (source routing key +
 *    event name). System events (`__`-prefixed) are exempt upstream.
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
   * Check whether a rate-limit key is within its per-minute allowance, using a
   * sliding 60-second window. Callers key user events by
   * `<sourceRoutingKey>:<eventName>`; system events (`__`-prefixed) are exempt
   * upstream and never reach here.
   */
  checkRateLimit(rateKey: string): { allowed: boolean; retryAfterMs?: number } {
    return this.rateLimiter.check(rateKey);
  }

  /**
   * Clear all rate limit state (for testing).
   */
  reset(): void {
    this.rateLimiter.reset();
  }
}
