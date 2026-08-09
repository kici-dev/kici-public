/**
 * Canonical secret-key-name validation, shared by the orchestrator write paths
 * and the dashboard add-secret form.
 *
 * The rule exists to keep the at-rest encryption binding unambiguous. Every
 * scoped secret is encrypted with AES-GCM under the additional authenticated
 * data `${orgId}:${scope}:${key}`, which binds a ciphertext to the exact
 * location it was written to. That binding only holds if the concatenation
 * decomposes back to one triple: with a `:` allowed inside `key`, the pair
 * (scope `b`, key `c:d`) and the pair (scope `b:c`, key `d`) render the same
 * AAD, so a ciphertext written at one location authenticates at the other.
 *
 * `validateScopeName` already excludes `:` from every scope segment. Excluding
 * it from the key as well makes the AAD's tail two colon-free fields, so the
 * triple is recovered unambiguously by splitting from the right — regardless of
 * what `orgId` contains. That is why this validator is the other half of the
 * fix and shares the scope charset rather than defining a looser one.
 *
 * The AAD format itself is fixed: the same string decrypts stored values, so
 * length-prefixing or JSON-encoding it would strand every existing secret.
 * Constraining the inputs is what keeps the current format unambiguous.
 *
 * Enforced on WRITE paths only. Reads, deletes and listings deliberately stay
 * unvalidated so a key stored before this rule existed remains readable and
 * deletable — nothing already stored becomes unreachable.
 *
 * Kept dependency-free so the engine barrel stays browser-safe.
 */

/**
 * Allowed characters in a secret key. Deliberately identical to
 * `SCOPE_SEGMENT_PATTERN`: a key is a single segment, so it excludes both the
 * AAD separator `:` and the scope path separator `/`.
 */
export const SECRET_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Maximum length of a secret key. */
export const SECRET_KEY_MAX_LENGTH = 256;

/**
 * Validate a secret key name. Returns a human-readable error message, or
 * `null` when the key is valid.
 */
export function validateSecretKey(key: string): string | null {
  if (key.length === 0) {
    return 'Secret key must not be empty';
  }
  if (key.length > SECRET_KEY_MAX_LENGTH) {
    return `Secret key must be at most ${SECRET_KEY_MAX_LENGTH} characters`;
  }
  if (!SECRET_KEY_PATTERN.test(key)) {
    return 'Secret key may only contain letters, digits, and _ . - characters';
  }
  return null;
}

/** Error thrown by {@link assertValidSecretKey} for an invalid secret key. */
export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

/** Throw {@link SecretKeyError} when `key` is not a valid secret key. */
export function assertValidSecretKey(key: string): void {
  const error = validateSecretKey(key);
  if (error !== null) {
    throw new SecretKeyError(error);
  }
}
