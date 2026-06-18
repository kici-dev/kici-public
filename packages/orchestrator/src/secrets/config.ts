/**
 * Secret store configuration and master key loading.
 *
 * Loads the encryption master key from KICI_SECRET_KEY env var
 * or from a key file on disk. Uses deriveKey() from crypto.ts
 * to normalize the key material to a 32-byte Buffer.
 */
import { readFileSync } from 'node:fs';
import { deriveKey } from './crypto.js';

/** Default environment variable name for the master key. */
const DEFAULT_ENV_KEY = 'KICI_SECRET_KEY';

/** Default environment variable name for the old master key (rotation). */
const DEFAULT_OLD_ENV_KEY = 'KICI_SECRET_KEY_OLD';

/**
 * Secret store configuration.
 */
export interface SecretStoreConfig {
  /** 32-byte AES-256 encryption key. */
  masterKey: Buffer;
  /** Key version for rotation tracking. Default 1. */
  keyVersion: number;
  /** Path to key file, if used. */
  keyFilePath: string | undefined;
  /** Previous master key for dual-key rotation. */
  oldMasterKey?: Buffer;
}

/**
 * Load the master encryption key from environment or file.
 *
 * Priority:
 * 1. Environment variable (envKey, defaults to KICI_SECRET_KEY)
 * 2. Key file (keyFilePath)
 *
 * @param envKey - Environment variable name to read. Defaults to KICI_SECRET_KEY.
 * @param keyFilePath - Optional path to a file containing the key material.
 * @returns 32-byte Buffer suitable for AES-256-GCM.
 * @throws If neither env var nor key file provides a valid key.
 */
export function loadMasterKey(envKey?: string, keyFilePath?: string): Buffer {
  const envName = envKey ?? DEFAULT_ENV_KEY;
  const envValue = process.env[envName];

  if (envValue) {
    return deriveKey(envValue.trim());
  }

  if (keyFilePath) {
    const fileContent = readFileSync(keyFilePath, 'utf-8').trim();
    if (!fileContent) {
      throw new Error(`Key file at '${keyFilePath}' is empty.`);
    }
    return deriveKey(fileContent);
  }

  throw new Error(
    `Secret encryption key not found. Set the ${envName} environment variable ` +
      '(64-char hex or base64-encoded 32 bytes) or provide a key file path.',
  );
}

/**
 * Load the old (previous) master encryption key for key rotation.
 *
 * Returns undefined when no old key is configured (normal operation).
 * Returns a 32-byte Buffer when KICI_SECRET_KEY_OLD or a key file is set.
 *
 * @param envKey - Environment variable name to read. Defaults to KICI_SECRET_KEY_OLD.
 * @param keyFilePath - Optional path to a file containing the old key material.
 * @returns 32-byte Buffer or undefined if no old key is configured.
 */
export function loadOldMasterKey(envKey?: string, keyFilePath?: string): Buffer | undefined {
  const envName = envKey ?? DEFAULT_OLD_ENV_KEY;
  const envValue = process.env[envName];

  if (envValue) {
    return deriveKey(envValue.trim());
  }

  if (keyFilePath) {
    const fileContent = readFileSync(keyFilePath, 'utf-8').trim();
    if (!fileContent) {
      return undefined;
    }
    return deriveKey(fileContent);
  }

  return undefined;
}

/**
 * Load the full secret store configuration.
 *
 * @param opts - Optional overrides for env var name, key file path, and key version.
 * @returns Complete SecretStoreConfig ready for PgSecretStore.
 */
export function loadSecretStoreConfig(opts?: {
  envKey?: string;
  keyFilePath?: string;
  keyVersion?: number;
  oldEnvKey?: string;
  oldKeyFilePath?: string;
}): SecretStoreConfig {
  const keyFilePath = opts?.keyFilePath;
  const masterKey = loadMasterKey(opts?.envKey, keyFilePath);
  const oldMasterKey = loadOldMasterKey(opts?.oldEnvKey, opts?.oldKeyFilePath);

  return {
    masterKey,
    keyVersion: opts?.keyVersion ?? 1,
    keyFilePath,
    oldMasterKey,
  };
}
