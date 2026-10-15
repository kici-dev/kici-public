import { createHash } from 'node:crypto';

/**
 * Width of the object-key discriminator, in hex characters (32 = 128 bits).
 *
 * A security property: on a case-insensitive namespace the discriminator alone
 * separates object names chosen by untrusted workflow code, and a narrower one
 * would let that code search case variants for a collision and land two
 * payloads on one object.
 */
export const KEY_DISCRIMINATOR_LENGTH = 32;

/**
 * A collision-resistant discriminator for a user-supplied object-key segment.
 *
 * Hashes the **exact** pre-sanitization name: `seg()` maps both `/` and `_` to
 * `_` (`a/b` and `a_b` collapse), and a case-insensitive backend folds `build`
 * onto `Build`, so only the hash keeps each pair two objects.
 */
export function keyDiscriminator(exact: string): string {
  return createHash('sha256')
    .update(exact, 'utf8')
    .digest('hex')
    .slice(0, KEY_DISCRIMINATOR_LENGTH);
}
