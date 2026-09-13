import { describe, it, expect } from 'vitest';
import { signToken, verifyToken, generateSigningSecret } from './sign-url.js';

describe('sign-url', () => {
  const secret = generateSigningSecret();

  it('generateSigningSecret yields 64-char hex', () => {
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(generateSigningSecret()).not.toBe(secret);
  });

  it('signToken + verifyToken round-trip succeeds for GET', () => {
    const { token } = signToken(secret, 'GET', 'dep/abc123');
    const result = verifyToken(secret, 'GET', 'dep/abc123', token);
    expect(result.ok).toBe(true);
  });

  it('signToken + verifyToken round-trip succeeds for PUT', () => {
    const { token } = signToken(secret, 'PUT', 'source/xyz');
    const result = verifyToken(secret, 'PUT', 'source/xyz', token);
    expect(result.ok).toBe(true);
  });

  it('rejects when verifying with the wrong method', () => {
    const { token } = signToken(secret, 'GET', 'dep/abc');
    const result = verifyToken(secret, 'PUT', 'dep/abc', token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');
  });

  it('rejects when verifying with the wrong key', () => {
    const { token } = signToken(secret, 'GET', 'dep/abc');
    const result = verifyToken(secret, 'GET', 'dep/xyz', token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');
  });

  it('rejects when verifying with the wrong secret', () => {
    const otherSecret = generateSigningSecret();
    const { token } = signToken(secret, 'GET', 'dep/abc');
    const result = verifyToken(otherSecret, 'GET', 'dep/abc', token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');
  });

  it('rejects expired tokens', () => {
    const { token } = signToken(secret, 'GET', 'dep/abc', -1_000);
    const result = verifyToken(secret, 'GET', 'dep/abc', token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects malformed tokens', () => {
    for (const bad of ['', '.', 'no-dot', '.abc', '123.', 'abc.xyz']) {
      const result = verifyToken(secret, 'GET', 'dep/abc', bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['malformed', 'bad-signature']).toContain(result.reason);
    }
  });

  it('rejects when signature length differs from expected', () => {
    const result = verifyToken(secret, 'GET', 'dep/abc', `${Date.now() + 1000}.deadbeef`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');
  });

  it('returns the expiry timestamp in the success case', () => {
    const before = Date.now();
    const { token, expiresMs } = signToken(secret, 'GET', 'k', 60_000);
    const after = Date.now();
    const result = verifyToken(secret, 'GET', 'k', token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expiresMs).toBe(expiresMs);
      expect(result.expiresMs).toBeGreaterThanOrEqual(before + 60_000);
      expect(result.expiresMs).toBeLessThanOrEqual(after + 60_000);
    }
  });
});
