import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySignature } from './signature.js';

describe('verifySignature', () => {
  const secret = 'test-webhook-secret';
  const body = '{"event":"push","data":"test"}';

  function computeSignature(data: string, key: string): string {
    const hmac = createHmac('sha256', key);
    hmac.update(data, 'utf8');
    return `sha256=${hmac.digest('hex')}`;
  }

  it('should return true for valid signature', () => {
    const signature = computeSignature(body, secret);
    expect(verifySignature(body, signature, secret)).toBe(true);
  });

  it('should return false for invalid signature', () => {
    const signature = 'sha256=invalid0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    expect(verifySignature(body, signature, secret)).toBe(false);
  });

  it('should return false when signature is missing sha256= prefix', () => {
    const hmac = createHmac('sha256', secret);
    hmac.update(body, 'utf8');
    const invalidSignature = hmac.digest('hex'); // Missing "sha256=" prefix
    expect(verifySignature(body, invalidSignature, secret)).toBe(false);
  });

  it('should return false for empty signature', () => {
    expect(verifySignature(body, '', secret)).toBe(false);
  });

  it('should verify against empty body HMAC when body is empty', () => {
    const emptyBody = '';
    const signature = computeSignature(emptyBody, secret);
    expect(verifySignature(emptyBody, signature, secret)).toBe(true);
  });

  it('should return false when wrong secret is used', () => {
    const signature = computeSignature(body, 'wrong-secret');
    expect(verifySignature(body, signature, secret)).toBe(false);
  });

  it('should return false when signature has different length than expected', () => {
    const shortSignature = 'sha256=abc123'; // Too short
    expect(verifySignature(body, shortSignature, secret)).toBe(false);
  });

  it('should return false for non-hex characters in signature (not throw)', () => {
    // 64 non-hex chars — same string length as a valid SHA-256 hex digest
    const nonHexSig = 'sha256=' + 'z'.repeat(64);
    expect(verifySignature(body, nonHexSig, secret)).toBe(false);
  });

  it('should return false for partially non-hex signature', () => {
    // Mix of hex and non-hex chars — Buffer.from('hex') silently drops invalid pairs
    const mixedSig = 'sha256=' + 'ab'.repeat(16) + 'zz'.repeat(16);
    expect(verifySignature(body, mixedSig, secret)).toBe(false);
  });

  it('should handle signature of correct length but different value', () => {
    // Create a valid-length but incorrect signature
    const validSignature = computeSignature(body, secret);
    const wrongSignature = validSignature.replace(/a/g, 'b'); // Modify but keep length
    expect(verifySignature(body, wrongSignature, secret)).toBe(false);
  });
});
