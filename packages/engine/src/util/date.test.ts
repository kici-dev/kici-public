import { describe, expect, it } from 'vitest';
import { toIsoString } from './date.js';

describe('toIsoString', () => {
  it('formats a Date as ISO-8601', () => {
    expect(toIsoString(new Date(Date.UTC(2026, 9, 4)))).toBe('2026-10-04T00:00:00.000Z');
  });
  // fails-when: a string is re-parsed and normalised instead of passed through
  it('passes a non-ISO string through unchanged', () => {
    expect(toIsoString('2026-10-04 00:00:00+00')).toBe('2026-10-04 00:00:00+00');
  });
});
