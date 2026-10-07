import { describe, expect, it } from 'vitest';
import { formatExpiryDuration, parseExpiryDuration } from './expiry-duration.js';
import { MAX_APPROVAL_EXPIRY_SECONDS } from '../protocol/messages/platform-orchestrator.js';

describe('parseExpiryDuration', () => {
  it.each([
    ['72h', 259_200],
    ['30m', 1_800],
    ['90s', 90],
    ['1h30m', 5_400],
    ['2h0m5s', 7_205],
  ])('parses %s', (input, seconds) => {
    expect(parseExpiryDuration(input)).toBe(seconds);
  });

  it.each(['', '72', 'h', '1.5h', '-1h', '1d', '1h 30m', '1m1h'])('refuses %j', (input) => {
    // fails-when: a malformed value parses to some number instead of throwing.
    expect(() => parseExpiryDuration(input)).toThrow();
  });

  it('refuses zero and values above the maximum', () => {
    expect(() => parseExpiryDuration('0s')).toThrow(RangeError);
    expect(() => parseExpiryDuration(`${MAX_APPROVAL_EXPIRY_SECONDS + 1}s`)).toThrow(RangeError);
    // breaks-if-wrong: the maximum itself is a legal window.
    expect(parseExpiryDuration('8760h')).toBe(MAX_APPROVAL_EXPIRY_SECONDS);
  });

  it('round-trips through formatExpiryDuration', () => {
    for (const s of [1, 59, 60, 3_600, 5_400, 259_200]) {
      expect(parseExpiryDuration(formatExpiryDuration(s))).toBe(s);
    }
  });
});

describe('formatExpiryDuration', () => {
  it.each([
    [90, '1m30s'],
    [5_400, '1h30m'],
    [259_200, '72h'],
    [0, '0s'],
  ])('formats %d as %s', (seconds, text) => {
    expect(formatExpiryDuration(seconds)).toBe(text);
  });
});
