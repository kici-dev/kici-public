/**
 * WebSocket rate limiter with two-tier token bucket (messages + bytes).
 *
 * Provides defense-in-depth against DoS by limiting:
 * - Message count per second (burst capacity + refill)
 * - Byte throughput per second (burst capacity + refill)
 * - Hard message size limit (4MB default)
 *
 * Heartbeats are exempt from rate limiting.
 * Sustained violations (>5s default) result in disconnect.
 */

/**
 * Token bucket algorithm for rate limiting.
 *
 * Supports burst up to `capacity` tokens, refilling at `refillRate` tokens/second.
 * When tokens are exhausted, returns a retryAfterMs estimate.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillRate: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume `amount` tokens.
   * @returns `{ allowed: true }` if tokens available, or `{ allowed: false, retryAfterMs }`.
   */
  consume(amount: number = 1): { allowed: boolean; retryAfterMs?: number } {
    this.refill();
    if (this.tokens >= amount) {
      this.tokens -= amount;
      return { allowed: true };
    }
    const deficit = amount - this.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillRate) * 1000);
    return { allowed: false, retryAfterMs };
  }

  /**
   * Check if `amount` tokens are available without consuming them.
   * @returns `{ allowed: true }` if tokens available, or `{ allowed: false, retryAfterMs }`.
   */
  peek(amount: number = 1): { allowed: boolean; retryAfterMs?: number } {
    this.refill();
    if (this.tokens >= amount) {
      return { allowed: true };
    }
    const deficit = amount - this.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillRate) * 1000);
    return { allowed: false, retryAfterMs };
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

export interface RateLimiterConfig {
  /** Maximum burst of messages. Default: 200 */
  messageCapacity?: number;
  /** Message refill rate per second. Default: 100 */
  messageRefillRate?: number;
  /** Maximum burst of bytes. Default: 2MB */
  bytesCapacity?: number;
  /** Bytes refill rate per second. Default: 500KB */
  bytesRefillRate?: number;
  /** Hard message size limit in bytes. Default: 4MB */
  maxMessageSize?: number;
  /** Time in ms of sustained violation before disconnect. Default: 5000 */
  disconnectAfterMs?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  action: 'allow' | 'warn' | 'disconnect';
  retryAfterMs?: number;
  reason?: string;
}

/**
 * Two-tier WebSocket rate limiter.
 *
 * Checks both message count and byte throughput independently.
 * Heartbeats are exempt. Oversized messages trigger immediate disconnect.
 * Sustained violations (exceeding `disconnectAfterMs`) trigger disconnect.
 */
export class WsRateLimiter {
  private readonly messages: TokenBucket;
  private readonly bytes: TokenBucket;
  private violationStart: number | null = null;
  private readonly maxMessageSize: number;
  private readonly bytesCapacity: number;
  private readonly disconnectAfterMs: number;

  constructor(config?: RateLimiterConfig) {
    const bytesCapacity = config?.bytesCapacity ?? 2 * 1024 * 1024;
    this.messages = new TokenBucket(
      config?.messageCapacity ?? 200,
      config?.messageRefillRate ?? 100,
    );
    this.bytes = new TokenBucket(bytesCapacity, config?.bytesRefillRate ?? 500 * 1024);
    this.maxMessageSize = config?.maxMessageSize ?? 4 * 1024 * 1024;
    this.bytesCapacity = bytesCapacity;
    this.disconnectAfterMs = config?.disconnectAfterMs ?? 5000;
  }

  /**
   * Check if a message is allowed through.
   *
   * @param messageSize - Size of the message in bytes
   * @param isHeartbeat - Whether this is a heartbeat message (exempt from limiting)
   * @returns Rate limit decision with action and optional retryAfterMs
   */
  check(messageSize: number, isHeartbeat: boolean): RateLimitResult {
    // Heartbeats are always exempt
    if (isHeartbeat) return { allowed: true, action: 'allow' };

    // Hard size limit check -- reject immediately
    if (messageSize > this.maxMessageSize) {
      return { allowed: false, action: 'disconnect', reason: 'Message too large' };
    }

    // Messages larger than byte bucket capacity can never pass (tokens cap at capacity).
    // Reject immediately instead of entering a misleading warn/retry loop.
    if (messageSize > this.bytesCapacity) {
      return {
        allowed: false,
        action: 'disconnect',
        reason: 'Message exceeds byte burst capacity',
      };
    }

    // Check both buckets without consuming — only debit tokens if both allow
    const msgResult = this.messages.peek(1);
    const byteResult = this.bytes.peek(messageSize);

    if (msgResult.allowed && byteResult.allowed) {
      this.messages.consume(1);
      this.bytes.consume(messageSize);
      this.violationStart = null;
      return { allowed: true, action: 'allow' };
    }

    // Rate limit exceeded -- track violation duration
    if (this.violationStart === null) {
      this.violationStart = Date.now();
    }

    const violationDuration = Date.now() - this.violationStart;
    if (violationDuration > this.disconnectAfterMs) {
      return {
        allowed: false,
        action: 'disconnect',
        reason: 'Sustained rate limit violation',
      };
    }

    const retryAfterMs = Math.max(msgResult.retryAfterMs ?? 0, byteResult.retryAfterMs ?? 0);
    return { allowed: false, action: 'warn', retryAfterMs };
  }
}
