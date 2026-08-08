/**
 * Tests for the `kici-admin token` CLI helpers — the `--expires` parser.
 */
import { describe, it, expect } from 'vitest';
import { parseExpiresAt } from './token.js';

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
