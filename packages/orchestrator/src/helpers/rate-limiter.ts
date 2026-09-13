/**
 * Sliding-window rate limiter.
 *
 * Tracks timestamps of recent events per key and rejects new events once the
 * count within the window exceeds the configured maximum.
 *
 * The internal Map stays bounded to the recently-active key set. A checked key
 * whose window has fully expired is dropped before this call decides whether to
 * record a new timestamp, so a call that records nothing (for example when the
 * limit is zero) leaves no residual bucket. Keys that are never checked again
 * are reclaimed by an amortized sweep that runs at most once per window, so the
 * per-call hot path stays O(1) amortized even though a single sweep is O(n).
 */
export class SlidingWindowRateLimiter {
  private state = new Map<string, number[]>();
  private lastSweepAt = 0;

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

    // Reclaim idle buckets at most once per window (amortized O(1) per call).
    this.maybeSweep(now, windowStart);

    let timestamps = this.state.get(key);
    if (timestamps) {
      // Trim timestamps that have aged out of the window.
      const firstValid = timestamps.findIndex((t) => t > windowStart);
      if (firstValid > 0) {
        timestamps.splice(0, firstValid);
      } else if (firstValid === -1) {
        // Whole window expired. Drop the bucket now; it is recreated lazily
        // below only if this call actually records a timestamp.
        this.state.delete(key);
        timestamps = undefined;
      }
    }

    const count = timestamps?.length ?? 0;
    if (count >= max) {
      // For max >= 1 the bucket is non-empty so timestamps[0] is defined;
      // the `?? now` guard only applies to the degenerate max <= 0 path where
      // no timestamp exists, yielding a full-window retry instead of NaN.
      const oldestInWindow = timestamps?.[0] ?? now;
      const retryAfterMs = oldestInWindow + this.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
    }

    // Allowed: record the event, creating the bucket lazily.
    if (!timestamps) {
      timestamps = [];
      this.state.set(key, timestamps);
    }
    timestamps.push(now);
    return { allowed: true };
  }

  /**
   * Evict buckets whose newest timestamp is outside the window. Runs at most
   * once per window so the amortized cost per check() stays O(1).
   */
  private maybeSweep(now: number, windowStart: number): void {
    if (now - this.lastSweepAt < this.windowMs) {
      return;
    }
    this.lastSweepAt = now;
    for (const [key, timestamps] of this.state) {
      const newest = timestamps[timestamps.length - 1];
      if (newest === undefined || newest <= windowStart) {
        this.state.delete(key);
      }
    }
  }

  /** Number of tracked keys currently held in the internal map. */
  get size(): number {
    return this.state.size;
  }

  reset(): void {
    this.state.clear();
    this.lastSweepAt = 0;
  }
}
