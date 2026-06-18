import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBucket, WsRateLimiter } from './rate-limiter.js';

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow consumption within capacity', () => {
    const bucket = new TokenBucket(10, 5);
    const result = bucket.consume(5);
    expect(result.allowed).toBe(true);
  });

  it('should reject consumption over capacity', () => {
    const bucket = new TokenBucket(10, 5);
    // Consume all tokens
    bucket.consume(10);
    const result = bucket.consume(1);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('should return correct retryAfterMs based on deficit and refill rate', () => {
    const bucket = new TokenBucket(10, 10); // 10 tokens/sec refill
    bucket.consume(10); // exhaust all
    const result = bucket.consume(5);
    expect(result.allowed).toBe(false);
    // Need 5 tokens at 10/sec = 500ms
    expect(result.retryAfterMs).toBe(500);
  });

  it('should refill tokens over time', () => {
    const bucket = new TokenBucket(10, 10); // 10 tokens/sec
    bucket.consume(10); // exhaust all

    // Advance time by 500ms -> should refill 5 tokens
    vi.advanceTimersByTime(500);

    const result = bucket.consume(5);
    expect(result.allowed).toBe(true);
  });

  it('should not exceed capacity on refill', () => {
    const bucket = new TokenBucket(10, 100); // fast refill
    bucket.consume(5);

    // Advance time by 1 second -> refill 100 tokens but capped at capacity 10
    vi.advanceTimersByTime(1000);

    // Should have full capacity: consume 10 should succeed
    const result = bucket.consume(10);
    expect(result.allowed).toBe(true);

    // But 1 more should fail
    const result2 = bucket.consume(1);
    expect(result2.allowed).toBe(false);
  });

  it('should not consume tokens on peek', () => {
    const bucket = new TokenBucket(5, 1);
    // Peek should report available without consuming
    const peekResult = bucket.peek(3);
    expect(peekResult.allowed).toBe(true);

    // Tokens should still be there — consume 5 should succeed
    const consumeResult = bucket.consume(5);
    expect(consumeResult.allowed).toBe(true);

    // Now bucket is exhausted
    const exhausted = bucket.consume(1);
    expect(exhausted.allowed).toBe(false);
  });

  it('should report deficit correctly on peek', () => {
    const bucket = new TokenBucket(3, 10); // 10 tokens/sec refill
    bucket.consume(3); // exhaust all
    const peekResult = bucket.peek(5);
    expect(peekResult.allowed).toBe(false);
    // Need 5 tokens at 10/sec = 500ms
    expect(peekResult.retryAfterMs).toBe(500);
  });

  it('should default amount to 1', () => {
    const bucket = new TokenBucket(1, 1);
    const result = bucket.consume();
    expect(result.allowed).toBe(true);
    const result2 = bucket.consume();
    expect(result2.allowed).toBe(false);
  });
});

describe('WsRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow normal messages within limits', () => {
    const limiter = new WsRateLimiter();
    const result = limiter.check(100, false);
    expect(result.allowed).toBe(true);
    expect(result.action).toBe('allow');
  });

  it('should always allow heartbeats even when rate limited', () => {
    // Create a limiter with very small capacity to easily exhaust it
    const limiter = new WsRateLimiter({
      messageCapacity: 1,
      messageRefillRate: 1,
      bytesCapacity: 100,
      bytesRefillRate: 10,
    });

    // Exhaust the limiter
    limiter.check(50, false);
    const limited = limiter.check(50, false);
    expect(limited.allowed).toBe(false);

    // Heartbeat should still be allowed
    const heartbeat = limiter.check(100, true);
    expect(heartbeat.allowed).toBe(true);
    expect(heartbeat.action).toBe('allow');
  });

  it('should reject oversized messages with disconnect action', () => {
    const limiter = new WsRateLimiter({ maxMessageSize: 1000 });
    const result = limiter.check(1001, false);
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('disconnect');
    expect(result.reason).toBe('Message too large');
  });

  it('should use default 4MB max message size', () => {
    const limiter = new WsRateLimiter();
    const fourMB = 4 * 1024 * 1024;

    // Exactly 4MB should be allowed (if byte capacity allows)
    const limiterBig = new WsRateLimiter({ bytesCapacity: 5 * 1024 * 1024 });
    const atLimit = limiterBig.check(fourMB, false);
    expect(atLimit.allowed).toBe(true);

    // Over 4MB should be rejected
    const overLimit = limiterBig.check(fourMB + 1, false);
    expect(overLimit.allowed).toBe(false);
    expect(overLimit.action).toBe('disconnect');
  });

  it('should immediately disconnect for messages exceeding byte burst capacity', () => {
    const limiter = new WsRateLimiter({
      bytesCapacity: 1000,
      maxMessageSize: 5000,
    });

    // Message within byte capacity -- allowed
    const ok = limiter.check(500, false);
    expect(ok.allowed).toBe(true);

    // Message between bytesCapacity and maxMessageSize -- immediate disconnect
    // (previously this would enter a misleading warn/retry loop)
    const overCapacity = limiter.check(1500, false);
    expect(overCapacity.allowed).toBe(false);
    expect(overCapacity.action).toBe('disconnect');
    expect(overCapacity.reason).toBe('Message exceeds byte burst capacity');

    // Exactly at bytesCapacity boundary -- should be allowed (if tokens available)
    const limiter2 = new WsRateLimiter({
      bytesCapacity: 1000,
      maxMessageSize: 5000,
    });
    const atLimit = limiter2.check(1000, false);
    expect(atLimit.allowed).toBe(true);
  });

  it('should warn on rate limit violation (not disconnect immediately)', () => {
    const limiter = new WsRateLimiter({
      messageCapacity: 2,
      messageRefillRate: 1,
    });

    limiter.check(10, false);
    limiter.check(10, false);
    // Third message exceeds capacity
    const result = limiter.check(10, false);
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('warn');
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('should disconnect after sustained violation exceeding disconnectAfterMs', () => {
    const limiter = new WsRateLimiter({
      messageCapacity: 1,
      messageRefillRate: 0.001, // very slow refill
      disconnectAfterMs: 100,
    });

    // First message -- allowed
    limiter.check(10, false);

    // Second message -- warn
    const warn = limiter.check(10, false);
    expect(warn.action).toBe('warn');

    // Advance time past disconnectAfterMs
    vi.advanceTimersByTime(150);

    // Still rate limited, and now past threshold
    const result = limiter.check(10, false);
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('disconnect');
    expect(result.reason).toBe('Sustained rate limit violation');
  });

  it('should reset violation timer when traffic falls back within limits', () => {
    const limiter = new WsRateLimiter({
      messageCapacity: 3,
      messageRefillRate: 10,
      disconnectAfterMs: 500,
    });

    // Use up capacity
    limiter.check(10, false);
    limiter.check(10, false);
    limiter.check(10, false);

    // Violation starts
    const warn = limiter.check(10, false);
    expect(warn.action).toBe('warn');

    // Wait for refill (300ms should refill 3 tokens)
    vi.advanceTimersByTime(300);

    // Now within limits again -- violation timer resets
    const ok = limiter.check(10, false);
    expect(ok.allowed).toBe(true);
    expect(ok.action).toBe('allow');
  });

  it('should enforce byte bucket independently of message bucket', () => {
    const limiter = new WsRateLimiter({
      messageCapacity: 1000, // plenty of messages
      bytesCapacity: 100, // small byte limit
      bytesRefillRate: 10,
    });

    // First message with 100 bytes -- allowed
    const result1 = limiter.check(100, false);
    expect(result1.allowed).toBe(true);

    // Second message with 50 bytes -- byte bucket exhausted
    const result2 = limiter.check(50, false);
    expect(result2.allowed).toBe(false);
    expect(result2.action).toBe('warn');
  });

  it('should not drain one bucket when the other denies (atomic check)', () => {
    // Message bucket: 5 capacity, near-zero refill (tokens won't recover)
    // Byte bucket: 50 capacity, 50/sec refill (recovers in 1s)
    const limiter = new WsRateLimiter({
      messageCapacity: 5,
      messageRefillRate: 0.001,
      bytesCapacity: 50,
      bytesRefillRate: 50,
    });

    // Exhaust byte bucket: send a 50-byte message (1 msg token + 50 byte tokens)
    const r1 = limiter.check(50, false);
    expect(r1.allowed).toBe(true);

    // Now byte bucket is empty. Send another message — should be denied.
    const r2 = limiter.check(10, false);
    expect(r2.allowed).toBe(false);

    // The message bucket should NOT have been debited for the denied message.
    // We used 1 message token for the first allowed message, so 4 remain.
    // Wait for byte bucket to refill, then send 4 tiny messages — all should pass.
    vi.advanceTimersByTime(2000); // refill bytes (50/sec * 2s = 100 tokens, capped at 50)

    for (let i = 0; i < 4; i++) {
      const r = limiter.check(1, false);
      expect(r.allowed).toBe(true);
    }

    // 5th should fail (message bucket exhausted: 1 initial + 4 just now = 5 total)
    const rFinal = limiter.check(1, false);
    expect(rFinal.allowed).toBe(false);
  });

  it('should accept configurable parameters', () => {
    const limiter = new WsRateLimiter({
      messageCapacity: 5,
      messageRefillRate: 2,
      bytesCapacity: 5000,
      bytesRefillRate: 1000,
      maxMessageSize: 2000,
      disconnectAfterMs: 10000,
    });

    // Under max message size -- allowed (within byte capacity too)
    const result = limiter.check(100, false);
    expect(result.allowed).toBe(true);

    // Over custom max message size -- disconnect
    const result2 = limiter.check(2001, false);
    expect(result2.allowed).toBe(false);
    expect(result2.action).toBe('disconnect');
  });
});
