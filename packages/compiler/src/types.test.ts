import { describe, it, expect } from 'vitest';
import * as lockTypes from './types.js';

describe('lock dynamic-field shapes', () => {
  // fails-when: the inline-expression reader is exported from the compiler lock types again
  it('has no inline-expression guard', () => {
    expect('isLockInlineValue' in lockTypes).toBe(false);
  });

  // breaks-if-wrong: the live lock-shape guards must still be exported
  it('keeps the live lock-shape guards', () => {
    expect(typeof lockTypes.isLockParallelStep).toBe('function');
    expect(typeof lockTypes.isLockStaticJob).toBe('function');
  });
});
