import { describe, expect, it } from 'vitest';
import { clampLimit } from './admin-list-limit.js';

describe('clampLimit', () => {
  it.each([
    [undefined, 50],
    ['', 50],
    ['abc', 50],
    ['0', 50],
    ['-5', 50],
    ['1', 1],
    ['7.9', 7],
    ['12abc', 12],
    ['200', 200],
    // fails-when: the cap is dropped or moved
    ['201', 200],
    ['99999', 200],
  ])('maps %j to %d', (raw, expected) => {
    expect(clampLimit(raw)).toBe(expected);
  });
});
