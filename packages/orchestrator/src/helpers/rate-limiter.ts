/**
 * Sliding-window rate limiter.
 *
 * Tracks timestamps of recent events per key and rejects new events
 * once the count within the window exceeds the configured maximum.
 */
export class SlidingWindowRateLimiter {
  private state = new Map<string, number[]>();

  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs = 60_000,
  ) {}

  /**
   * Check if a new event is allowed for the given key.
   * @param key - The rate limit bucket key.
   * @param maxOverride - Per-call limit override (uses constructor default if omitted).
   */
  check(key: string, maxOverride?: number): { allowed: boolean; retryAfterMs?: number } {
    const max = maxOverride ?? this.maxPerWindow;
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.state.get(key);
    if (!timestamps) {
      timestamps = [];
      this.state.set(key, timestamps);
    }

    // Clean expired timestamps
    const firstValid = timestamps.findIndex((t) => t > windowStart);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    } else if (firstValid === -1 && timestamps.length > 0) {
      timestamps.length = 0;
    }

    if (timestamps.length >= max) {
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow + this.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
    }

    timestamps.push(now);
    return { allowed: true };
  }

  reset(): void {
    this.state.clear();
  }
}
