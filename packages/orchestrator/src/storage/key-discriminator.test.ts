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

  // `seg()` maps both `/` and `_` to `_`; hashing the EXACT name keeps them apart.
  it('separates names that sanitize to the same segment', () => {
    expect(keyDiscriminator('a/b')).not.toBe(keyDiscriminator('a_b'));
  });

  // On a case-insensitive namespace the discriminator alone separates names
  // chosen by untrusted workflow code.
  it('separates names differing only by case', () => {
    expect(keyDiscriminator('build')).not.toBe(keyDiscriminator('Build'));
  });
});
