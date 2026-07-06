import { describe, expect, it } from 'vitest';
import { OidcMintErrorCode, oidcMintRequestSchema, oidcMintResponseSchema } from './oidc-mint.js';

describe('oidc.mint protocol', () => {
  it('parses a valid request', () => {
    const msg = {
      type: 'oidc.mint.request',
      requestId: 'r1',
      orchestratorId: 'orch-1',
      runId: 'run-1',
      jobId: 'job-1',
      audience: 'https://example.test',
    };
    expect(oidcMintRequestSchema.parse(msg)).toEqual(msg);
  });

  it('parses a result response', () => {
    const msg = {
      type: 'oidc.mint.response',
      requestId: 'r1',
      result: { token: 'jwt', expiresIn: 600, jti: 'jti-1' },
    };
    expect(oidcMintResponseSchema.parse(msg)).toEqual(msg);
  });

  it('parses each error code', () => {
    for (const code of OidcMintErrorCode.options) {
      const msg = { type: 'oidc.mint.response', requestId: 'r1', error: { code, message: 'x' } };
      expect(oidcMintResponseSchema.parse(msg).error?.code).toBe(code);
    }
  });

  it('rejects a response with both result and error', () => {
    const msg = {
      type: 'oidc.mint.response',
      requestId: 'r1',
      result: { token: 'jwt', expiresIn: 600, jti: 'jti-1' },
      error: { code: 'failed', message: 'x' },
    };
    expect(() => oidcMintResponseSchema.parse(msg)).toThrow();
  });

  it('rejects a response with neither result nor error', () => {
    expect(() =>
      oidcMintResponseSchema.parse({ type: 'oidc.mint.response', requestId: 'r1' }),
    ).toThrow();
  });
});
