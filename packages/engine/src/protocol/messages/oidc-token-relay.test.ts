import { describe, expect, it } from 'vitest';
import {
  OIDC_TOKEN_REQUEST_METHOD,
  oidcTokenRequestParamsSchema,
  oidcTokenResultSchema,
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
