/**
 * Secret store configuration and master key loading.
 *
 * Loads the encryption master key from KICI_SECRET_KEY env var
 * or from a key file on disk. Uses deriveKey() from crypto.ts
 * to normalize the key material to a 32-byte Buffer.
 */
import { readFileSync } from 'node:fs';
import { deriveKey } from '@kici-dev/shared';

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
  return deriveKey(loadMasterKeyMaterial(envKey, keyFilePath));
}

/**
 * Load the master key MATERIAL — the raw configured string, before
 * {@link deriveKey}. Same env-then-file precedence as {@link loadMasterKey}.
 *
 * Several master-key-wrapped stores take the key as a string and derive it
 * themselves (`unwrapPrivateJwk`, `ephemeral-keys.decryptPrivateKey`). Reading
 * `config.secretKey` at those call sites honours `KICI_SECRET_KEY` but silently
 * ignores `KICI_SECRET_KEY_FILE`, so an operator who supplies the key by file
 * gets no signing key and no dashboard-encryption key. Resolving the material
 * here keeps one precedence rule for both the Buffer and string forms.
 */
export function loadMasterKeyMaterial(envKey?: string, keyFilePath?: string): string {
  const envName = envKey ?? DEFAULT_ENV_KEY;
  const envValue = process.env[envName];

  if (envValue) {
    return envValue.trim();
  }

  if (keyFilePath) {
    const fileContent = readFileSync(keyFilePath, 'utf-8').trim();
    if (!fileContent) {
      throw new Error(`Key file at '${keyFilePath}' is empty.`);
    }
    return fileContent;
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
  const material = loadOldMasterKeyMaterial(envKey, keyFilePath);
  return material === undefined ? undefined : deriveKey(material);
}

/**
 * Load the old master key MATERIAL — the raw configured string, before
 * {@link deriveKey}. The string-form counterpart of {@link loadOldMasterKey},
 * for the wrapped stores that take the key as a string.
 */
export function loadOldMasterKeyMaterial(
  envKey?: string,
  keyFilePath?: string,
): string | undefined {
  const envName = envKey ?? DEFAULT_OLD_ENV_KEY;
  const envValue = process.env[envName];

  if (envValue) {
    return envValue.trim();
  }

  if (keyFilePath) {
    const fileContent = readFileSync(keyFilePath, 'utf-8').trim();
    if (!fileContent) {
      return undefined;
    }
    return fileContent;
  }

  return undefined;
}

/**
 * The master key in both the forms the wrapped stores need: the raw configured
 * material (for stores that take a string and derive it themselves) and the
 * derived AES key (for stores that hold a Buffer), each paired with the
 * previous generation during a rotation grace window.
 *
 * Resolved once at boot so every master-key-wrapped store agrees on the same
 * key, and so `KICI_SECRET_KEY_FILE` reaches all of them rather than only the
 * two that happened to call {@link loadMasterKey}.
 */
export interface ResolvedMasterKeys {
  /** Raw configured key material, before {@link deriveKey}. */
  material: string;
  /** The previous generation's raw material, when a rotation window is open. */
  materialOld: string | undefined;
  /** Derived 32-byte AES key. */
  current: Buffer;
  /** The previous generation's derived key, when a rotation window is open. */
  old: Buffer | undefined;
}

/**
 * Resolve the master key (and, when configured, its predecessor) from the
 * env-then-file precedence both loaders use. Returns null when no master key is
 * configured at all — the secrets subsystem is off in that case.
 */
export function resolveMasterKeys(opts: {
  secretKey?: string | undefined;
  secretKeyFile?: string | undefined;
  secretKeyFileOld?: string | undefined;
}): ResolvedMasterKeys | null {
  if (!opts.secretKey && !opts.secretKeyFile) return null;
  const material = loadMasterKeyMaterial(undefined, opts.secretKeyFile);
  const materialOld = loadOldMasterKeyMaterial(undefined, opts.secretKeyFileOld);
  return {
    material,
    materialOld,
    current: deriveKey(material),
    old: materialOld === undefined ? undefined : deriveKey(materialOld),
  };
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
