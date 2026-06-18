import { describe, it, expect } from 'vitest';
import { formatMatrixSuffix, formatExpandedJobName } from './format.js';

describe('formatMatrixSuffix', () => {
  it('returns the single-dimension value directly', () => {
    expect(formatMatrixSuffix({ value: 'linux' })).toBe('linux');
  });

  it('joins multi-dimensional values with ", "', () => {
    expect(formatMatrixSuffix({ os: 'linux', arch: 'arm64' })).toBe('linux, arm64');
  });

  it('filters undefined values', () => {
    expect(formatMatrixSuffix({ os: 'linux', arch: undefined })).toBe('linux');
  });

  it('keeps all dimensions when a multi-dim matrix has a dimension named "value"', () => {
    // A dimension literally named `value` must not be mistaken for the
    // single-dimension sentinel — otherwise sibling combinations collide.
    expect(formatMatrixSuffix({ value: 'x86', os: 'linux' })).toBe('x86, linux');
    expect(formatMatrixSuffix({ value: 'x86', os: 'macos' })).toBe('x86, macos');
  });
});

describe('formatExpandedJobName', () => {
  it('wraps the suffix in parentheses after the base name', () => {
    expect(formatExpandedJobName('build', { value: 'a' })).toBe('build (a)');
    expect(formatExpandedJobName('build', { os: 'linux', arch: 'arm64' })).toBe(
      'build (linux, arm64)',
    );
  });
});
