import { describe, it, expect } from 'vitest';
import { normalizeIp, isTrustedProxy, extractRemoteIp } from './ip-extraction.js';

// ── Mock Hono Context ────────────────────────────────────────────────

function createMockContext(headers: Record<string, string> = {}): any {
  return {
    req: {
      header: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? undefined,
    },
  };
}

function createMockConnInfo(address?: string): any {
  return {
    remote: { address },
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('normalizeIp', () => {
  it('strips ::ffff: prefix from IPv6-mapped IPv4', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
  });

  it('returns plain IPv4 unchanged', () => {
    expect(normalizeIp('192.168.1.1')).toBe('192.168.1.1');
  });

  it('returns pure IPv6 unchanged', () => {
    expect(normalizeIp('::1')).toBe('::1');
  });

  it('returns full IPv6 unchanged', () => {
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('isTrustedProxy', () => {
  it('returns true for exact IP match', () => {
    expect(isTrustedProxy('127.0.0.1', ['127.0.0.1'])).toBe(true);
  });

  it('returns true for CIDR match', () => {
    expect(isTrustedProxy('10.0.0.5', ['10.0.0.0/8'])).toBe(true);
  });

  it('returns false for CIDR non-match', () => {
    expect(isTrustedProxy('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
  });

  it('normalizes IPv6-mapped IPv4 before comparison', () => {
    expect(isTrustedProxy('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true);
  });

  it('returns false for empty list', () => {
    expect(isTrustedProxy('192.168.1.1', [])).toBe(false);
  });

  it('handles /16 CIDR range', () => {
    expect(isTrustedProxy('172.16.5.10', ['172.16.0.0/16'])).toBe(true);
    expect(isTrustedProxy('172.17.0.1', ['172.16.0.0/16'])).toBe(false);
  });

  it('handles /32 CIDR (exact match)', () => {
    expect(isTrustedProxy('10.0.0.1', ['10.0.0.1/32'])).toBe(true);
    expect(isTrustedProxy('10.0.0.2', ['10.0.0.1/32'])).toBe(false);
  });
});

describe('extractRemoteIp', () => {
  it('returns X-Real-IP when socket is trusted proxy', () => {
    const c = createMockContext({ 'X-Real-IP': '203.0.113.50' });
    const connInfo = createMockConnInfo('127.0.0.1');
    expect(extractRemoteIp(c, connInfo, ['127.0.0.1'])).toBe('203.0.113.50');
  });

  it('returns first X-Forwarded-For entry when trusted proxy and no X-Real-IP', () => {
    const c = createMockContext({ 'X-Forwarded-For': '198.51.100.10, 10.0.0.1' });
    const connInfo = createMockConnInfo('127.0.0.1');
    expect(extractRemoteIp(c, connInfo, ['127.0.0.1'])).toBe('198.51.100.10');
  });

  it('returns socket IP when socket is NOT a trusted proxy', () => {
    const c = createMockContext({ 'X-Real-IP': '203.0.113.50' });
    const connInfo = createMockConnInfo('192.168.1.100');
    expect(extractRemoteIp(c, connInfo, ['127.0.0.1'])).toBe('192.168.1.100');
  });

  it('returns socket IP when no proxy headers present', () => {
    const c = createMockContext({});
    const connInfo = createMockConnInfo('10.0.0.5');
    expect(extractRemoteIp(c, connInfo, ['10.0.0.5'])).toBe('10.0.0.5');
  });

  it('returns "unknown" when socket address is undefined', () => {
    const c = createMockContext({ 'X-Real-IP': '1.2.3.4' });
    const connInfo = createMockConnInfo(undefined);
    expect(extractRemoteIp(c, connInfo, ['127.0.0.1'])).toBe('unknown');
  });

  it('rejects invalid IPs in X-Real-IP header', () => {
    const c = createMockContext({ 'X-Real-IP': 'not-an-ip' });
    const connInfo = createMockConnInfo('127.0.0.1');
    // Should fall through to socket IP since header is invalid
    expect(extractRemoteIp(c, connInfo, ['127.0.0.1'])).toBe('127.0.0.1');
  });

  it('rejects invalid IPs in X-Forwarded-For header', () => {
    const c = createMockContext({ 'X-Forwarded-For': 'garbage, 10.0.0.1' });
    const connInfo = createMockConnInfo('127.0.0.1');
    // First entry is invalid, should fall through to socket IP
    expect(extractRemoteIp(c, connInfo, ['127.0.0.1'])).toBe('127.0.0.1');
  });

  it('normalizes IPv6-mapped socket IP', () => {
    const c = createMockContext({});
    const connInfo = createMockConnInfo('::ffff:192.168.1.1');
    expect(extractRemoteIp(c, connInfo, [])).toBe('192.168.1.1');
  });

  it('prefers X-Real-IP over X-Forwarded-For when trusted', () => {
    const c = createMockContext({
      'X-Real-IP': '203.0.113.1',
      'X-Forwarded-For': '198.51.100.1, 10.0.0.1',
    });
    const connInfo = createMockConnInfo('127.0.0.1');
    expect(extractRemoteIp(c, connInfo, ['127.0.0.1'])).toBe('203.0.113.1');
  });

  it('handles trusted proxy via CIDR match', () => {
    const c = createMockContext({ 'X-Real-IP': '203.0.113.50' });
    const connInfo = createMockConnInfo('10.0.0.5');
    expect(extractRemoteIp(c, connInfo, ['10.0.0.0/8'])).toBe('203.0.113.50');
  });

  it('normalizes IPv6-mapped IPv4 in X-Real-IP header', () => {
    const c = createMockContext({ 'X-Real-IP': '::ffff:203.0.113.50' });
    const connInfo = createMockConnInfo('127.0.0.1');
    expect(extractRemoteIp(c, connInfo, ['127.0.0.1'])).toBe('203.0.113.50');
  });

  it('normalizes IPv6-mapped IPv4 in X-Forwarded-For header', () => {
    const c = createMockContext({ 'X-Forwarded-For': '::ffff:198.51.100.10, 10.0.0.1' });
    const connInfo = createMockConnInfo('127.0.0.1');
    expect(extractRemoteIp(c, connInfo, ['127.0.0.1'])).toBe('198.51.100.10');
  });
});
