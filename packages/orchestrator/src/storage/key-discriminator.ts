import { createHash } from 'node:crypto';

/**
 * Width of the object-key discriminator, in hex characters.
 *
 * 32 hex chars is 128 bits, and the width is a security property rather than a
 * formatting choice: on a case-insensitive namespace the discriminator is the
 * only thing separating object names chosen by untrusted workflow code. A
 * narrower value would let that code search case variants for a colliding pair
 * and land two different payloads on one object.
 */
export const KEY_DISCRIMINATOR_LENGTH = 32;

/**
 * A collision-resistant discriminator for a user-supplied object-key segment.
 *
 * Hashes the **exact** name, before any sanitization. Sanitizing is many-to-one
 * — `seg()` maps both `/` and `_` to `_`, so `a/b` and `a_b` collapse to one
 * segment — and a case-insensitive backend folds `build` onto `Build`. Hashing
 * the pre-sanitization name is what keeps each of those pairs two objects.
 */
export function keyDiscriminator(exact: string): string {
  return createHash('sha256')
    .update(exact, 'utf8')
    .digest('hex')
    .slice(0, KEY_DISCRIMINATOR_LENGTH);
}
