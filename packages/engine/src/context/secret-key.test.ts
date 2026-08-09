import { describe, it, expect } from 'vitest';
import {
  validateSecretKey,
  assertValidSecretKey,
  SecretKeyError,
  SECRET_KEY_PATTERN,
  SECRET_KEY_MAX_LENGTH,
} from './secret-key.js';
import { SCOPE_SEGMENT_PATTERN } from './scope-name.js';

describe('validateSecretKey', () => {
  it('accepts the key shapes the product actually stores', () => {
    for (const key of [
      'API_KEY',
      'DB_PASSWORD',
      'NPM_TOKEN',
      'MY_SECRET',
      'pat',
      'privateKey',
      'webhookSecret',
      'aws.access-key',
      'a',
      'A1',
      '_leading',
      '-leading',
      '.leading',
    ]) {
      expect(validateSecretKey(key), key).toBeNull();
    }
  });

  it('rejects a key containing the AAD separator', () => {
    // `${orgId}:${scope}:${key}` is the AES-GCM AAD. A `:` in the key makes the
    // decomposition ambiguous, so two distinct locations share one AAD.
    expect(validateSecretKey('c:d')).not.toBeNull();
    expect(validateSecretKey(':')).not.toBeNull();
    expect(validateSecretKey('trailing:')).not.toBeNull();
  });

  it('rejects the concrete confusion pair from the defect report', () => {
    // scope="b", key="c:d" and scope="b:c", key="d" both render AAD "a:b:c:d".
    // The scope half is already rejected by validateScopeName; rejecting the key
    // half is what closes the pair.
    const ambiguous = 'c:d';
    expect(validateSecretKey(ambiguous)).not.toBeNull();
  });

  it('rejects a path separator, so a key stays a single segment', () => {
    expect(validateSecretKey('a/b')).not.toBeNull();
  });

  it('rejects an empty key', () => {
    expect(validateSecretKey('')).not.toBeNull();
  });

  it('rejects characters outside the charset', () => {
    for (const key of ['a b', 'a\tb', 'a\nb', 'kéy', 'a$b', 'a*b', 'a%b', 'a\u0000b', 'a#b']) {
      expect(validateSecretKey(key), JSON.stringify(key)).not.toBeNull();
    }
  });

  it('bounds the length', () => {
    expect(validateSecretKey('x'.repeat(SECRET_KEY_MAX_LENGTH))).toBeNull();
    expect(validateSecretKey('x'.repeat(SECRET_KEY_MAX_LENGTH + 1))).not.toBeNull();
  });

  it('returns a message naming the allowed characters', () => {
    expect(validateSecretKey('bad:key')).toMatch(/letters, digits/);
  });

  it('exposes a charset identical to the scope-segment charset', () => {
    // Both halves of the AAD's tail must exclude `:` for the concatenation to
    // decompose uniquely; keeping one charset keeps that property obvious.
    expect(SECRET_KEY_PATTERN.test('A9._-')).toBe(true);
    expect(SECRET_KEY_PATTERN.test('a:b')).toBe(false);

    // Assert the identity the name claims, rather than spot-checking two
    // strings: sweep every single-byte code point and require both patterns to
    // agree. The two literals are written in a different order
    // (`[A-Za-z0-9._-]` vs `[A-Za-z0-9_.-]`), so comparing `.source` would
    // report a difference that does not exist — compare behaviour instead.
    // This is what fails if either charset is ever widened on its own.
    for (let code = 0; code < 128; code++) {
      const ch = String.fromCharCode(code);
      expect(SECRET_KEY_PATTERN.test(ch), `code point ${code}`).toBe(
        SCOPE_SEGMENT_PATTERN.test(ch),
      );
    }
  });

  it('is anchored, so a valid prefix does not smuggle a separator', () => {
    // An unanchored pattern would accept "good\n:evil" via multiline semantics.
    expect(validateSecretKey('good\n:evil')).not.toBeNull();
    expect(validateSecretKey('good\nevil')).not.toBeNull();
  });
});

describe('assertValidSecretKey', () => {
  it('does not throw for a valid key', () => {
    expect(() => assertValidSecretKey('API_KEY')).not.toThrow();
  });

  it('throws SecretKeyError for an invalid key', () => {
    expect(() => assertValidSecretKey('a:b')).toThrow(SecretKeyError);
  });

  it('carries the validator message', () => {
    expect(() => assertValidSecretKey('a:b')).toThrow(/letters, digits/);
  });
});
