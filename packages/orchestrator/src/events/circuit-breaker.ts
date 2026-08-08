import { SlidingWindowRateLimiter } from '../helpers/rate-limiter.js';
import type { EventRouterConfig } from './types.js';
import type { ClusterSettingsReader } from '../cluster/cluster-settings-reader.js';

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

  constructor(
    private readonly config: EventRouterConfig,
    private readonly clusterSettings?: ClusterSettingsReader,
  ) {
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
   *
   * The per-(source routing key + event) limit is the fleet-wide cluster
   * tunable `event_router_rate_limit_per_workflow_per_minute` (live override
   * wins), falling back to the configured default.
   */
  async checkRateLimit(rateKey: string): Promise<{ allowed: boolean; retryAfterMs?: number }> {
    const maxPerWindow =
      (await this.clusterSettings?.getNumber(
        'event_router_rate_limit_per_workflow_per_minute',
        this.config.rateLimitPerWorkflowPerMinute,
      )) ?? this.config.rateLimitPerWorkflowPerMinute;
    return this.rateLimiter.check(rateKey, maxPerWindow);
  }

  /**
   * Clear all rate limit state (for testing).
   */
  reset(): void {
    this.rateLimiter.reset();
  }
}
