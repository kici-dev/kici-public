import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGenericWebhook } from './verification.js';
import type {
  HmacVerificationConfig,
  BearerVerificationConfig,
  IpAllowlistVerificationConfig,
  NoneVerificationConfig,
} from './verification.js';

describe('verifyGenericWebhook', () => {
  describe('hmac_sha256', () => {
    const secret = 'test-webhook-secret';
    const body = '{"event":"deploy","env":"prod"}';

    function computeSignature(payload: string, key: string, prefix = true): string {
      const hmac = createHmac('sha256', key);
      hmac.update(payload, 'utf8');
      const hex = hmac.digest('hex');
      return prefix ? `sha256=${hex}` : hex;
    }

    it('passes with valid sha256= prefixed signature in default header', () => {
      const config: HmacVerificationConfig = { method: 'hmac_sha256', secret };
      const signature = computeSignature(body, secret);
      const headers = { 'x-signature-256': signature };

      expect(verifyGenericWebhook(body, headers, config)).toBe(true);
    });

    it('passes with valid raw hex signature in default header', () => {
      const config: HmacVerificationConfig = { method: 'hmac_sha256', secret };
      const signature = computeSignature(body, secret, false);
      const headers = { 'x-signature-256': signature };

      expect(verifyGenericWebhook(body, headers, config)).toBe(true);
    });

    it('fails with invalid signature', () => {
      const config: HmacVerificationConfig = { method: 'hmac_sha256', secret };
      const headers = {
        'x-signature-256':
          'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      };

      expect(verifyGenericWebhook(body, headers, config)).toBe(false);
    });

    it('fails with missing signature header', () => {
      const config: HmacVerificationConfig = { method: 'hmac_sha256', secret };
      const headers = {};

      expect(verifyGenericWebhook(body, headers, config)).toBe(false);
    });

    it('uses custom header name', () => {
      const config: HmacVerificationConfig = {
        method: 'hmac_sha256',
        secret,
        headerName: 'x-custom-sig',
      };
      const signature = computeSignature(body, secret);
      const headers = { 'x-custom-sig': signature };

      expect(verifyGenericWebhook(body, headers, config)).toBe(true);
    });

    it('fails with wrong secret', () => {
      const config: HmacVerificationConfig = { method: 'hmac_sha256', secret };
      const signature = computeSignature(body, 'wrong-secret');
      const headers = { 'x-signature-256': signature };

      expect(verifyGenericWebhook(body, headers, config)).toBe(false);
    });

    it('returns false (not throws) for malformed hex signature with correct string length', () => {
      const config: HmacVerificationConfig = { method: 'hmac_sha256', secret };
      // 64 chars (correct length for SHA256 hex) but invalid hex characters
      const malformedHex = 'zz'.repeat(32);
      const headers = { 'x-signature-256': malformedHex };

      // Should return false, not throw RangeError from timingSafeEqual
      expect(verifyGenericWebhook(body, headers, config)).toBe(false);
    });
  });

  describe('bearer_token', () => {
    const token = 'my-secret-bearer-token';

    it('passes with valid Bearer token in Authorization header', () => {
      const config: BearerVerificationConfig = { method: 'bearer_token', token };
      const headers = { authorization: `Bearer ${token}` };

      expect(verifyGenericWebhook('', headers, config)).toBe(true);
    });

    it('passes with raw token (no Bearer prefix)', () => {
      const config: BearerVerificationConfig = { method: 'bearer_token', token };
      const headers = { authorization: token };

      expect(verifyGenericWebhook('', headers, config)).toBe(true);
    });

    it('fails with invalid token', () => {
      const config: BearerVerificationConfig = { method: 'bearer_token', token };
      const headers = { authorization: 'Bearer wrong-token' };

      expect(verifyGenericWebhook('', headers, config)).toBe(false);
    });

    it('fails with missing authorization header', () => {
      const config: BearerVerificationConfig = { method: 'bearer_token', token };
      const headers = {};

      expect(verifyGenericWebhook('', headers, config)).toBe(false);
    });

    it('uses custom header name', () => {
      const config: BearerVerificationConfig = {
        method: 'bearer_token',
        token,
        headerName: 'x-webhook-token',
      };
      const headers = { 'x-webhook-token': token };

      expect(verifyGenericWebhook('', headers, config)).toBe(true);
    });

    it('rejects token of different length (timing-safe)', () => {
      const config: BearerVerificationConfig = { method: 'bearer_token', token };
      const headers = { authorization: 'short' };

      expect(verifyGenericWebhook('', headers, config)).toBe(false);
    });
  });

  describe('ip_allowlist', () => {
    it('passes with allowed IP', () => {
      const config: IpAllowlistVerificationConfig = {
        method: 'ip_allowlist',
        allowlist: ['10.0.0.1', '10.0.0.2', '192.168.1.100'],
      };

      expect(verifyGenericWebhook('', {}, config, '10.0.0.1')).toBe(true);
      expect(verifyGenericWebhook('', {}, config, '192.168.1.100')).toBe(true);
    });

    it('fails with disallowed IP', () => {
      const config: IpAllowlistVerificationConfig = {
        method: 'ip_allowlist',
        allowlist: ['10.0.0.1', '10.0.0.2'],
      };

      expect(verifyGenericWebhook('', {}, config, '10.0.0.3')).toBe(false);
    });

    it('fails with no client IP', () => {
      const config: IpAllowlistVerificationConfig = {
        method: 'ip_allowlist',
        allowlist: ['10.0.0.1'],
      };

      expect(verifyGenericWebhook('', {}, config)).toBe(false);
      expect(verifyGenericWebhook('', {}, config, undefined)).toBe(false);
    });

    it('fails with empty allowlist', () => {
      const config: IpAllowlistVerificationConfig = {
        method: 'ip_allowlist',
        allowlist: [],
      };

      expect(verifyGenericWebhook('', {}, config, '10.0.0.1')).toBe(false);
    });
  });

  describe('none', () => {
    it('always passes', () => {
      const config: NoneVerificationConfig = { method: 'none' };

      expect(verifyGenericWebhook('', {}, config)).toBe(true);
      expect(verifyGenericWebhook('any body', { 'x-foo': 'bar' }, config)).toBe(true);
    });
  });
});
