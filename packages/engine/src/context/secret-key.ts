/**
 * Canonical secret-key-name validation, shared by the orchestrator write paths
 * and the dashboard add-secret form.
 *
 * It keeps the at-rest encryption binding unambiguous. Every scoped secret is
 * AES-GCM encrypted under the AAD `${orgId}:${scope}:${key}`, binding the
 * ciphertext to its exact location — but only if the string decomposes to one
 * triple: with `:` allowed in `key`, (scope `b`, key `c:d`) and (scope `b:c`,
 * key `d`) render the same AAD, so a ciphertext authenticates at both locations.
 *
 * `validateScopeName` already excludes `:` from scope segments; excluding it
 * from the key too makes the AAD tail two colon-free fields, recoverable by
 * splitting from the right whatever `orgId` contains. Hence the key shares the
 * scope charset rather than a looser one.
 *
 * The AAD format itself cannot change: it decrypts stored values, so
 * length-prefixing or JSON-encoding it would strand every existing secret.
 *
 * Enforced on WRITE paths only: reads, deletes and listings stay unvalidated so
 * a key stored before this rule stays readable and deletable.
 *
 * Kept dependency-free so the engine barrel stays browser-safe.
 */

/**
 * Allowed characters in a secret key, identical to `SCOPE_SEGMENT_PATTERN`: a
 * key is a single segment, so it excludes the AAD separator `:` and the path
 * separator `/`.
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
