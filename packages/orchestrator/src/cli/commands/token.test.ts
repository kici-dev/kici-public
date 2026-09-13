/**
 * Tests for the `kici-admin token` CLI helpers — the `--expires` parser and
 * the `token list` table renderer.
 */
import { describe, it, expect } from 'vitest';
import { formatTokenTable, parseExpiresAt } from './token.js';

describe('parseExpiresAt', () => {
  const now = new Date('2026-07-14T00:00:00.000Z');

  it('parses a day-duration shorthand relative to now', () => {
    expect(parseExpiresAt('30d', now).getTime()).toBe(now.getTime() + 30 * 86_400_000);
  });

  it('parses an hour-duration shorthand', () => {
    expect(parseExpiresAt('12h', now).getTime()).toBe(now.getTime() + 12 * 3_600_000);
  });

  it('parses a minute-duration shorthand', () => {
    expect(parseExpiresAt('45m', now).getTime()).toBe(now.getTime() + 45 * 60_000);
  });

  it('parses an absolute ISO-8601 datetime', () => {
    expect(parseExpiresAt('2026-12-31T00:00:00Z', now).toISOString()).toBe(
      '2026-12-31T00:00:00.000Z',
    );
  });

  it('rejects a zero/negative duration', () => {
    expect(() => parseExpiresAt('0d', now)).toThrow(/positive/);
  });

  it('rejects garbage input rather than silently creating a non-expiring token', () => {
    expect(() => parseExpiresAt('soon', now)).toThrow(/--expires/);
  });

  it('rejects an overflowing duration rather than producing an Invalid Date', () => {
    expect(() => parseExpiresAt('999999999999d', now)).toThrow(/too large/);
  });
});

describe('formatTokenTable', () => {
  it('renders a token with no recorded holder as unlinked, not a dash', () => {
    const table = formatTokenTable([
      { id: 'tok-1', label: 'ops', role: 'admin', subject: null, routing_key: null },
    ]);
    expect(table).toContain('Subject');
    expect(table).toContain('unlinked');
  });

  it('renders the recorded holder when one is present', () => {
    const table = formatTokenTable([
      {
        id: 'tok-2',
        label: 'alice-ops',
        role: 'admin',
        subject: 'alice@example.test',
        routing_key: 'github:42',
      },
    ]);
    expect(table).toContain('alice@example.test');
    expect(table).not.toContain('unlinked');
  });
});
