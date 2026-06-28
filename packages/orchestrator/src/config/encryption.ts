/**
 * Config field encryption/decryption/redaction.
 *
 * Provides helpers to encrypt sensitive fields in a config object before
 * storing in the database, decrypt them on read, and redact them for display.
 *
 * Uses AES-256-GCM from the existing secrets/crypto.ts module.
 * Supports glob patterns (e.g., 'providers.github.*.privateKey') for
 * array and object traversal.
 */
import { encrypt, decrypt, type EncryptedValue } from '@kici-dev/shared';

/** Sentinel value used for redacted fields in display/export. */
export const REDACTED_VALUE = '***REDACTED***';

/**
 * AAD prefix for config field encryption (binds ciphertext to config context).
 *
 * This value is load-bearing: every historical ciphertext in `config_versions`
 * was sealed under `config-field:<path>`. Changing it breaks decrypt for every
 * existing row and has no clean migration path — do NOT edit.
 */
const AAD_PREFIX = 'config-field:';

/**
 * Deep-clone an object using structured clone.
 */
function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

/**
 * Get a value at a nested path in an object.
 * Returns undefined if the path doesn't exist.
 *
 * @param obj - The object to traverse
 * @param path - Dot-separated path (e.g., 'providers.github.appId')
 */
export function deepGet(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Set a value at a nested path in an object.
 * Creates intermediate objects as needed.
 *
 * @param obj - The object to modify (mutated in place)
 * @param path - Dot-separated path (e.g., 'providers.github.appId')
 * @param value - The value to set
 */
export function deepSet(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (
      current[segment] === null ||
      current[segment] === undefined ||
      typeof current[segment] !== 'object'
    ) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  current[segments[segments.length - 1]] = value;
}

/**
 * Resolve a glob pattern path to concrete paths in an object.
 * Supports '*' as a wildcard for array indices or object keys at one level.
 *
 * Example: 'providers.github.*.privateKey' on an object where
 * providers.github is an array of 2 items resolves to:
 * ['providers.github.0.privateKey', 'providers.github.1.privateKey']
 *
 * @param obj - The object to inspect
 * @param pattern - Dot-separated path with optional '*' wildcards
 * @returns Array of concrete dot-separated paths that exist in the object
 */
export function resolveGlobPaths(obj: Record<string, unknown>, pattern: string): string[] {
  const segments = pattern.split('.');
  return resolveSegments(obj, segments, 0, '');
}

function resolveSegments(
  current: unknown,
  segments: string[],
  index: number,
  prefix: string,
): string[] {
  if (index >= segments.length) {
    // We've consumed all segments -- this is a concrete path if value exists
    return current !== undefined && current !== null ? [prefix] : [];
  }

  if (current === null || current === undefined || typeof current !== 'object') {
    return [];
  }

  const segment = segments[index];
  const obj = current as Record<string, unknown>;

  if (segment === '*') {
    // Wildcard: iterate all keys (works for both arrays and objects)
    const results: string[] = [];
    const keys = Array.isArray(current) ? current.map((_, i) => String(i)) : Object.keys(obj);
    for (const key of keys) {
      const childPrefix = prefix ? `${prefix}.${key}` : key;
      results.push(...resolveSegments(obj[key], segments, index + 1, childPrefix));
    }
    return results;
  }

  // Regular segment
  const childPrefix = prefix ? `${prefix}.${segment}` : segment;
  return resolveSegments(obj[segment], segments, index + 1, childPrefix);
}

/**
 * Encrypt sensitive fields in a config object.
 *
 * Traverses each sensitive field path pattern, resolves glob wildcards,
 * and encrypts string values in place (in the cloned object).
 *
 * @param config - The config object to encrypt (not mutated)
 * @param paths - Array of field path patterns (may contain '*' wildcards)
 * @param key - 32-byte AES-256 encryption key
 * @param keyVersion - Master-key generation that encrypted these values.
 *   Stored alongside the ciphertext so rotation can identify and re-seal rows.
 * @returns Object with the encrypted config clone and list of actual encrypted paths
 */
export function encryptConfigFields(
  config: Record<string, unknown>,
  paths: string[],
  key: Buffer,
  keyVersion: number,
): { encrypted: Record<string, unknown>; encryptedPaths: string[] } {
  const cloned = deepClone(config);
  const encryptedPaths: string[] = [];

  for (const pattern of paths) {
    const concretePaths = resolveGlobPaths(cloned, pattern);
    for (const path of concretePaths) {
      const value = deepGet(cloned, path);
      if (typeof value === 'string' && value.length > 0) {
        const encrypted = encrypt(value, key, keyVersion, `${AAD_PREFIX}${path}`);
        deepSet(cloned, path, encrypted.data);
        encryptedPaths.push(path);
      }
    }
  }

  return { encrypted: cloned, encryptedPaths };
}

/**
 * Decrypt sensitive fields in a config object.
 *
 * Uses the encrypted_paths array (stored alongside the config in the DB)
 * to know exactly which paths need decryption.
 *
 * Accepts an optional `oldKey` so rows encrypted under a previous master-key
 * generation continue to decrypt during the rotation grace window — matches
 * `PgSecretStore.decryptWithFallback`.
 *
 * @param config - The config object with encrypted fields (not mutated)
 * @param encryptedPaths - Array of concrete paths that contain encrypted values
 * @param key - Current 32-byte AES-256 encryption key
 * @param keyVersion - Generation stored alongside the row (carried into
 *   `EncryptedValue.keyVersion` so the crypto layer can surface key-mismatch
 *   telemetry; the AAD fully binds the ciphertext).
 * @param oldKey - Optional previous generation key, tried when the current
 *   key fails (undefined/null means no fallback).
 * @returns Decrypted config clone
 */
export function decryptConfigFields(
  config: Record<string, unknown>,
  encryptedPaths: string[],
  key: Buffer,
  keyVersion: number,
  oldKey?: Buffer | null,
): Record<string, unknown> {
  const cloned = deepClone(config);

  for (const path of encryptedPaths) {
    const value = deepGet(cloned, path);
    if (typeof value === 'string' && value.length > 0) {
      const encryptedValue: EncryptedValue = {
        data: value,
        keyVersion,
      };
      const aad = `${AAD_PREFIX}${path}`;
      let decrypted: string;
      try {
        decrypted = decrypt(encryptedValue, key, aad);
      } catch (primaryErr) {
        if (!oldKey) {
          throw new Error(
            `Failed to decrypt config field '${path}' with current key (no old key configured)`,
            { cause: primaryErr },
          );
        }
        try {
          decrypted = decrypt(encryptedValue, oldKey, aad);
        } catch (fallbackErr) {
          throw new Error(
            `Failed to decrypt config field '${path}' with both current and old key`,
            { cause: fallbackErr },
          );
        }
      }
      deepSet(cloned, path, decrypted);
    }
  }

  return cloned;
}

/**
 * Redact sensitive fields in a config object for safe display.
 *
 * Replaces values at encrypted paths with '***REDACTED***'.
 * Used for CLI export and diff operations.
 *
 * @param config - The config object to redact (not mutated)
 * @param encryptedPaths - Array of concrete paths to redact
 * @returns Redacted config clone
 */
export function redactConfigFields(
  config: Record<string, unknown>,
  encryptedPaths: string[],
): Record<string, unknown> {
  const cloned = deepClone(config);

  for (const path of encryptedPaths) {
    const value = deepGet(cloned, path);
    if (value !== undefined && value !== null) {
      deepSet(cloned, path, REDACTED_VALUE);
    }
  }

  return cloned;
}
