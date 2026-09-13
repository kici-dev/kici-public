import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { KEY_DISCRIMINATOR_LENGTH, keyDiscriminator } from './key-discriminator.js';

describe('keyDiscriminator', () => {
  it('is exactly KEY_DISCRIMINATOR_LENGTH lowercase hex characters', () => {
    const d = keyDiscriminator('bundle');
    expect(d).toHaveLength(KEY_DISCRIMINATOR_LENGTH);
    expect(d).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is the leading half of the sha256 of the exact name', () => {
    expect(keyDiscriminator('bundle')).toBe(
      createHash('sha256')
        .update('bundle', 'utf8')
        .digest('hex')
        .slice(0, KEY_DISCRIMINATOR_LENGTH),
    );
  });

  it('is deterministic', () => {
    expect(keyDiscriminator('bundle')).toBe(keyDiscriminator('bundle'));
  });

  // Sanitizing is many-to-one: `seg()` maps both `/` and `_` to `_`, so two
  // distinct names collapse to one path segment. Hashing the EXACT name is what
  // keeps them apart.
  it('separates names that sanitize to the same segment', () => {
    expect(keyDiscriminator('a/b')).not.toBe(keyDiscriminator('a_b'));
  });

  // The case this exists for: on a case-insensitive namespace the discriminator
  // is the only thing separating names chosen by untrusted workflow code.
  it('separates names differing only by case', () => {
    expect(keyDiscriminator('build')).not.toBe(keyDiscriminator('Build'));
  });
});
