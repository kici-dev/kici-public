import { describe, expect, it } from 'vitest';
import { authRequestSchema, authSuccessSchema, authFailureSchema } from './auth.js';

describe('authRequestSchema', () => {
  const validRequest = {
    type: 'auth.request',
    token: 'kici_sk_abc123def456',
    protocolVersion: 1,
  };

  it('validates a well-formed auth request', () => {
    expect(authRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  it('rejects empty token', () => {
    expect(() => authRequestSchema.parse({ ...validRequest, token: '' })).toThrow();
  });

  it('rejects missing protocolVersion', () => {
    const { protocolVersion, ...rest } = validRequest;
    expect(() => authRequestSchema.parse(rest)).toThrow();
  });

  it('rejects non-positive protocolVersion', () => {
    expect(() => authRequestSchema.parse({ ...validRequest, protocolVersion: 0 })).toThrow();
    expect(() => authRequestSchema.parse({ ...validRequest, protocolVersion: -1 })).toThrow();
  });

  it('rejects non-integer protocolVersion', () => {
    expect(() => authRequestSchema.parse({ ...validRequest, protocolVersion: 1.5 })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validRequest));
    expect(authRequestSchema.parse(roundTripped)).toEqual(validRequest);
  });
});

describe('authSuccessSchema', () => {
  const validSuccess = {
    type: 'auth.success',
    connectionId: 'conn-abc-123',
  };

  it('validates a well-formed success response', () => {
    expect(authSuccessSchema.parse(validSuccess)).toEqual(validSuccess);
  });

  it('rejects missing connectionId', () => {
    const { connectionId, ...rest } = validSuccess;
    expect(() => authSuccessSchema.parse(rest)).toThrow();
  });

  it('strips unknown fields (no appId)', () => {
    const withAppId = { ...validSuccess, appId: 12345 };
    const result = authSuccessSchema.parse(withAppId);
    expect(result).not.toHaveProperty('appId');
    expect(result).toEqual(validSuccess);
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validSuccess));
    expect(authSuccessSchema.parse(roundTripped)).toEqual(validSuccess);
  });

  it('carries the canonical orgId and orgPublicAlias when supplied', () => {
    const msg = authSuccessSchema.parse({
      ...validSuccess,
      orgPublicAlias: 'oal_x',
      orgId: 'org_abc123def456',
    });
    expect(msg.orgId).toBe('org_abc123def456');
    expect(msg.orgPublicAlias).toBe('oal_x');
  });
});

describe('authFailureSchema', () => {
  const validFailure = {
    type: 'auth.failure',
    reason: 'Invalid API key',
  };

  it('validates a well-formed failure response', () => {
    expect(authFailureSchema.parse(validFailure)).toEqual(validFailure);
  });

  it('rejects missing reason', () => {
    expect(() => authFailureSchema.parse({ type: 'auth.failure' })).toThrow();
  });

  it('round-trips through JSON serialization', () => {
    const roundTripped = JSON.parse(JSON.stringify(validFailure));
    expect(authFailureSchema.parse(roundTripped)).toEqual(validFailure);
  });
});
