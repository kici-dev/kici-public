/**
 * WebSocket rate limiter (DoS defense in depth): token buckets for messages/s
 * and bytes/s, plus a hard message size limit (4MB default). Heartbeats are
 * exempt; sustained violations (>5s default) disconnect.
 */

/** Token bucket: bursts up to `capacity` tokens, refilling at `refillRate` tokens/second. */
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

  /** Consume `amount` tokens, or report `{ allowed: false, retryAfterMs }`. */
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

  /** Like `consume`, without consuming the tokens. */
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
 * Two-tier WebSocket rate limiter: message count and byte throughput are checked
 * independently. Heartbeats are exempt; an oversized message disconnects at
 * once, and a violation lasting past `disconnectAfterMs` disconnects.
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

  /** Decide whether a message (`messageSize` in bytes) is allowed through. */
  check(messageSize: number, isHeartbeat: boolean): RateLimitResult {
    if (isHeartbeat) return { allowed: true, action: 'allow' };

    if (messageSize > this.maxMessageSize) {
      return { allowed: false, action: 'disconnect', reason: 'Message too large' };
    }

    // Larger than the byte bucket's capacity can never pass: reject now rather
    // than enter a misleading warn/retry loop.
    if (messageSize > this.bytesCapacity) {
      return {
        allowed: false,
        action: 'disconnect',
        reason: 'Message exceeds byte burst capacity',
      };
    }

    // Debit tokens only when both buckets allow.
    const msgResult = this.messages.peek(1);
    const byteResult = this.bytes.peek(messageSize);

    if (msgResult.allowed && byteResult.allowed) {
      this.messages.consume(1);
      this.bytes.consume(messageSize);
      this.violationStart = null;
      return { allowed: true, action: 'allow' };
    }

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
