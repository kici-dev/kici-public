import { describe, it, expect } from 'vitest';
import { isStaticArray, isStaticObject, isDynamicFunction } from './types.js';
import type { Matrix } from './types.js';

describe('isStaticArray', () => {
  it('returns true for array', () => {
    expect(isStaticArray(['a', 'b'])).toBe(true);
  });

  it('returns false for object', () => {
    expect(isStaticArray({ os: ['linux'] } as unknown as Matrix)).toBe(false);
  });

  it('returns false for function', () => {
    const fn: Matrix = async () => ['a'];
    expect(isStaticArray(fn)).toBe(false);
  });
});

describe('isStaticObject', () => {
  it('returns true for plain object', () => {
    expect(isStaticObject({ os: ['linux'] } as unknown as Matrix)).toBe(true);
  });

  it('returns false for array', () => {
    expect(isStaticObject(['a', 'b'])).toBe(false);
  });

  it('returns false for function', () => {
    const fn: Matrix = async () => ['a'];
    expect(isStaticObject(fn)).toBe(false);
  });

  it('returns false for null (regression: typeof null === "object")', () => {
    // Callers may cast from unknown/any — the guard must not admit null.
    expect(isStaticObject(null as unknown as Matrix)).toBe(false);
  });
});

describe('isDynamicFunction', () => {
  it('returns true for function', () => {
    const fn: Matrix = async () => ['a'];
    expect(isDynamicFunction(fn)).toBe(true);
  });

  it('returns false for array', () => {
    expect(isDynamicFunction(['a'])).toBe(false);
  });

  it('returns false for object', () => {
    expect(isDynamicFunction({ os: ['linux'] } as unknown as Matrix)).toBe(false);
  });
});
