import { describe, expect, it } from 'vitest';
import {
  OIDC_TOKEN_REQUEST_METHOD,
  oidcTokenRequestParamsSchema,
  oidcTokenResultSchema,
  OidcMintErrorCode,
  deferredMintParamsSchema,
} from './oidc-token-relay.js';

describe('oidc token relay contract', () => {
  it('pins the method name', () => {
    expect(OIDC_TOKEN_REQUEST_METHOD).toBe('oidc.token.request');
  });

  it('accepts valid request params', () => {
    expect(oidcTokenRequestParamsSchema.parse({ jobId: 'job-1', audience: 'sigstore' })).toEqual({
      jobId: 'job-1',
      audience: 'sigstore',
    });
  });

  it('rejects empty jobId and out-of-range audience', () => {
    expect(oidcTokenRequestParamsSchema.safeParse({ jobId: '', audience: 'a' }).success).toBe(
      false,
    );
    expect(oidcTokenRequestParamsSchema.safeParse({ jobId: 'j', audience: '' }).success).toBe(
      false,
    );
    expect(
      oidcTokenRequestParamsSchema.safeParse({ jobId: 'j', audience: 'x'.repeat(256) }).success,
    ).toBe(false);
  });

  it('round-trips a result', () => {
    const r = { token: 'eyJ.a.b', expiresIn: 600, jti: 'run-1:job-1' };
    expect(oidcTokenResultSchema.parse(r)).toEqual(r);
  });

  it('rejects a non-positive expiresIn', () => {
    expect(oidcTokenResultSchema.safeParse({ token: 't', expiresIn: 0, jti: 'j' }).success).toBe(
      false,
    );
  });
});

describe('oidc-token-relay deferred contract', () => {
  it('accepts a deferred result with a transient code', () => {
    const r = oidcTokenResultSchema.parse({ deferred: true, code: 'unavailable' });
    expect(r).toEqual({ deferred: true, code: 'unavailable' });
  });
  it('rejects a deferred result carrying the permanent code', () => {
    expect(oidcTokenResultSchema.safeParse({ deferred: true, code: 'rejected' }).success).toBe(
      false,
    );
  });
  it('OidcMintErrorCode keeps the 3-way contract', () => {
    expect(OidcMintErrorCode.options).toEqual(['rejected', 'unavailable', 'failed']);
  });
  it('deferredMintParamsSchema requires a statement hash + non-live origin', () => {
    const p = deferredMintParamsSchema.parse({ statementHash: 'a'.repeat(64), origin: 'deferred' });
    expect(p.origin).toBe('deferred');
    expect(deferredMintParamsSchema.safeParse({ statementHash: 'x', origin: 'live' }).success).toBe(
      false,
    );
  });
});
