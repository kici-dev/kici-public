import { describe, it, expect } from 'vitest';
import {
  validateScopeName,
  assertValidScopeName,
  ScopeNameError,
  SCOPE_NAME_MAX_LENGTH,
} from './scope-name.js';

describe('validateScopeName', () => {
  it.each(['aws', 'aws/prod', 'aws/prod/db', 'a-b_c.d', 'v1.2', 'com.example'])(
    'accepts %s',
    (name) => {
      expect(validateScopeName(name)).toBeNull();
    },
  );

  it.each([
    ['', 'empty'],
    ['a//b', 'empty segment (double slash)'],
    ['a/', 'trailing slash'],
    ['/a', 'leading slash'],
    ['a%b', 'percent'],
    ['a:b', 'colon'],
    ['a b', 'whitespace'],
    ['.', 'dot segment'],
    ['..', 'dotdot segment'],
    ['a/./b', 'interior dot segment'],
    ['a/../b', 'interior dotdot segment'],
  ])('rejects %s (%s)', (name) => {
    expect(validateScopeName(name)).not.toBeNull();
  });

  it('rejects over-length names', () => {
    expect(validateScopeName('x'.repeat(SCOPE_NAME_MAX_LENGTH + 1))).not.toBeNull();
    expect(validateScopeName('x'.repeat(SCOPE_NAME_MAX_LENGTH))).toBeNull();
  });
});

describe('assertValidScopeName', () => {
  it('is a no-op for a valid name', () => {
    expect(() => assertValidScopeName('aws/prod')).not.toThrow();
  });
  it('throws ScopeNameError for an invalid name', () => {
    expect(() => assertValidScopeName('a//b')).toThrow(ScopeNameError);
  });
});
