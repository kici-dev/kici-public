import { describe, expect, it } from 'vitest';
import { parseDuration } from './parse-duration.js';

describe('parseDuration', () => {
  it('parses d/h/m', () => {
    expect(parseDuration('2d')).toBe(172_800_000);
    expect(parseDuration('3h')).toBe(10_800_000);
    expect(parseDuration('30m')).toBe(1_800_000);
  });
  // fails-when: an unknown unit or a malformed value is accepted instead of returning null
  it.each(['5w', '', 'd', '1.5h', ' 2d', '-1d'])('returns null for %j', (raw) => {
    expect(parseDuration(raw)).toBeNull();
  });
});
