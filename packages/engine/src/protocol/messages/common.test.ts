import { describe, expect, it } from 'vitest';
import {
  heartbeatSchema,
  ackSchema,
  nackSchema,
  errorSchema,
  buildUnsupportedMessageNack,
  NACK_EXEMPT_MESSAGE_TYPES,
} from './common.js';

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

  it('accepts a nack without messageId (uncorrelatable skew frame)', () => {
    const msg = { type: 'nack', receivedType: 'some.new.type', reason: 'unsupported' };
    expect(nackSchema.parse(msg)).toEqual(msg);
  });

  it('accepts a nack carrying receivedType', () => {
    const msg = { type: 'nack', messageId: 'm1', receivedType: 'foo.bar', reason: 'skew' };
    expect(nackSchema.parse(msg)).toEqual(msg);
  });

  it('round-trips through JSON serialization', () => {
    const msg = { type: 'nack' as const, messageId: 'msg-002', reason: 'parse error' };
    const roundTripped = JSON.parse(JSON.stringify(msg));
    expect(nackSchema.parse(roundTripped)).toEqual(msg);
  });
});

describe('buildUnsupportedMessageNack', () => {
  // A set that recognizes execution.status but not the fictitious brand.new.thing,
  // so the "genuinely-unknown type" cases below still NACK.
  const knownTypes = new Set(['execution.status', 'heartbeat', 'nack']);

  it('builds a NACK naming the received type', () => {
    const nack = buildUnsupportedMessageNack(
      { type: 'brand.new.thing' },
      'orchestrator',
      knownTypes,
    );
    expect(nack).not.toBeNull();
    expect(nack!.type).toBe('nack');
    expect(nack!.receivedType).toBe('brand.new.thing');
    expect(nack!.reason).toContain('brand.new.thing');
    expect(nack!.reason).toContain('upgrade the orchestrator');
    // Uncorrelatable frame → no messageId.
    expect(nack!.messageId).toBeUndefined();
    // The result is itself a valid nack frame.
    expect(nackSchema.parse(nack)).toEqual(nack);
  });

  it('echoes the offending frame messageId when present', () => {
    const nack = buildUnsupportedMessageNack(
      { type: 'brand.new.thing', messageId: 'req-9' },
      'platform',
      knownTypes,
    );
    expect(nack!.messageId).toBe('req-9');
    expect(nack!.reason).toContain('upgrade the platform');
  });

  it('returns null for a known type that failed validation (oversized field → stays drop-and-close)', () => {
    // A known message type whose frame failed the recognition chain (an
    // oversized field, not version skew) must return null so the caller closes
    // the connection instead of NACKing-and-keeping-alive.
    const nack = buildUnsupportedMessageNack(
      { type: 'execution.status', workflowName: 'x'.repeat(5000) },
      'platform',
      new Set(['execution.status']),
    );
    expect(nack).toBeNull();
  });

  it('still NACKs a genuinely-unknown type not in the known set', () => {
    const nack = buildUnsupportedMessageNack(
      { type: 'brand.new.thing' },
      'platform',
      new Set(['execution.status']),
    );
    expect(nack).not.toBeNull();
    expect(nack!.receivedType).toBe('brand.new.thing');
  });

  it('returns null for a genuinely malformed frame (no string type) — stays drop-and-warn', () => {
    expect(buildUnsupportedMessageNack({ notType: 1 }, 'orchestrator', knownTypes)).toBeNull();
    expect(buildUnsupportedMessageNack(null, 'orchestrator', knownTypes)).toBeNull();
    expect(buildUnsupportedMessageNack('garbage', 'orchestrator', knownTypes)).toBeNull();
    expect(buildUnsupportedMessageNack({ type: '' }, 'orchestrator', knownTypes)).toBeNull();
  });

  it('loop guard: never NACKs a nack frame', () => {
    expect(
      buildUnsupportedMessageNack({ type: 'nack', reason: 'x' }, 'orchestrator', knownTypes),
    ).toBeNull();
  });

  it('streaming exemption: never NACKs log.chunk / orch-log.chunk', () => {
    expect(buildUnsupportedMessageNack({ type: 'log.chunk' }, 'platform', knownTypes)).toBeNull();
    expect(
      buildUnsupportedMessageNack({ type: 'orch-log.chunk' }, 'platform', knownTypes),
    ).toBeNull();
  });

  it('exposes the exemption set', () => {
    expect(NACK_EXEMPT_MESSAGE_TYPES.has('nack')).toBe(true);
    expect(NACK_EXEMPT_MESSAGE_TYPES.has('log.chunk')).toBe(true);
    expect(NACK_EXEMPT_MESSAGE_TYPES.has('orch-log.chunk')).toBe(true);
    expect(NACK_EXEMPT_MESSAGE_TYPES.has('brand.new.thing')).toBe(false);
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
