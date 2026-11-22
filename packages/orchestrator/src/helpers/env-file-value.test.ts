import { describe, expect, it } from 'vitest';
import { containsLineBreak } from './env-file-value.js';

describe('containsLineBreak', () => {
  it('flags CR and LF only', () => {
    // fails-when: a CR or LF in a value is not flagged, so it starts a second env line
    expect(containsLineBreak('a\nb')).toBe(true);
    expect(containsLineBreak('a\rb')).toBe(true);
    // breaks-if-wrong: a bundle value with a tab or space is a single line
    expect(containsLineBreak('a\tb c')).toBe(false);
  });
});
