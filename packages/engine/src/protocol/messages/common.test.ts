import { describe, expect, it } from 'vitest';
import { heartbeatSchema, ackSchema, nackSchema, errorSchema } from './common.js';

describe('heartbeatSchema', () => {
  it('validates a well-formed heartbeat', () => {
    const msg = { type: 'heartbeat', timestamp: Date.now() };
    expect(heartbeatSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing timestamp', () => {
    expect(() => heartbeatSchema.parse({ type: 'heartbeat' })).toThrow();
  });

  it('rejects wrong type', () => {
    expect(() => heartbeatSchema.parse({ type: 'ack', timestamp: 123 })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const msg = { type: 'heartbeat' as const, timestamp: 1707300000000 };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(heartbeatSchema.parse(roundTripped)).toEqual(msg);
  });
});

describe('ackSchema', () => {
  it('validates a well-formed ack', () => {
    const msg = { type: 'ack', messageId: 'msg-001' };
    expect(ackSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing messageId', () => {
    expect(() => ackSchema.parse({ type: 'ack' })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const msg = { type: 'ack' as const, messageId: 'msg-001' };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(ackSchema.parse(roundTripped)).toEqual(msg);
  });
});

describe('nackSchema', () => {
  it('validates a well-formed nack', () => {
    const msg = { type: 'nack', messageId: 'msg-002', reason: 'unknown event' };
    expect(nackSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing reason', () => {
    expect(() => nackSchema.parse({ type: 'nack', messageId: 'msg-002' })).toThrow();
  });

  it('rejects missing messageId', () => {
    expect(() => nackSchema.parse({ type: 'nack', reason: 'error' })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const msg = { type: 'nack' as const, messageId: 'msg-002', reason: 'parse error' };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(nackSchema.parse(roundTripped)).toEqual(msg);
  });
});

describe('errorSchema', () => {
  it('validates a well-formed error', () => {
    const msg = { type: 'error', code: 'PROTO_VERSION_MISMATCH', message: 'Expected v1' };
    expect(errorSchema.parse(msg)).toEqual(msg);
  });

  it('rejects missing code', () => {
    expect(() => errorSchema.parse({ type: 'error', message: 'oops' })).toThrow();
  });

  it('rejects missing message', () => {
    expect(() => errorSchema.parse({ type: 'error', code: 'ERR' })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const msg = {
      type: 'error' as const,
      code: 'INTERNAL',
      message: 'Something went wrong',
    };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(errorSchema.parse(roundTripped)).toEqual(msg);
  });
});
