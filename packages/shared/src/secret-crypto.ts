/**
 * AES-256-GCM encryption layer for secrets management.
 *
 * Provides authenticated encryption with additional data (AAD)
 * to prevent cross-context secret swaps. The AAD is typically
 * "contextId:keyName" binding the ciphertext to its location.
 *
 * Wire format (base64 encoded): IV (12 bytes) || AuthTag (16 bytes) || Ciphertext
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/** Length of the initialization vector in bytes. */
const IV_LENGTH = 12;

/** Length of the GCM authentication tag in bytes. */
const TAG_LENGTH = 16;

/** Algorithm identifier for Node.js crypto. */
const ALGO = 'aes-256-gcm';

/**
 * Encrypted value with key version tracking.
 * The data field contains base64-encoded IV || AuthTag || Ciphertext.
 */
export interface EncryptedValue {
  /** Base64-encoded IV + auth tag + ciphertext. */
  data: string;
  /** Version of the encryption key used. */
  keyVersion: number;
}

/**
 * Encrypt a plaintext string using AES-256-GCM with AAD.
 *
 * @param plaintext - The string to encrypt
 * @param key - 32-byte encryption key
 * @param keyVersion - Version number for key rotation tracking
 * @param aad - Additional authenticated data (e.g., "contextId:keyName")
 * @returns Encrypted value with key version
 */
export function encrypt(
  plaintext: string,
  key: Buffer,
  keyVersion: number,
  aad: string,
): EncryptedValue {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad, 'utf-8'));

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: IV || AuthTag || Ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);

  return {
    data: packed.toString('base64'),
    keyVersion,
  };
}

/**
 * Decrypt an encrypted value using AES-256-GCM with AAD verification.
 *
 * @param encrypted - The encrypted value to decrypt
 * @param key - 32-byte encryption key (must match the key used for encryption)
 * @param aad - Additional authenticated data (must match the AAD used for encryption)
 * @returns Decrypted plaintext string
 * @throws If decryption fails (wrong key, wrong AAD, tampered data)
 */
export function decrypt(encrypted: EncryptedValue, key: Buffer, aad: string): string {
  const packed = Buffer.from(encrypted.data, 'base64');

  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short');
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(aad, 'utf-8'));

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

/**
 * Derive a 32-byte encryption key from a string input.
 *
 * Accepts two formats:
 * - 64-character hex string (e.g., from generateMasterKey())
 * - Base64-encoded 32-byte key
 *
 * @param input - Hex or base64 encoded key material
 * @returns 32-byte Buffer suitable for use with encrypt/decrypt
 * @throws If the derived key is not exactly 32 bytes
 */
export function deriveKey(input: string): Buffer {
  let key: Buffer;

  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    // 64 hex chars = 32 bytes
    key = Buffer.from(input, 'hex');
  } else {
    // Try base64
    key = Buffer.from(input, 'base64');
  }

  if (key.length !== 32) {
    throw new Error(
      `Encryption key must be exactly 32 bytes, got ${key.length} bytes. ` +
        'Provide a 64-character hex string or a base64-encoded 32-byte value.',
    );
  }

  return key;
}

/**
 * Generate a new random 32-byte master key as a hex string.
 *
 * @returns 64-character hex string suitable for KICI_SECRET_KEY env var
 */
export function generateMasterKey(): string {
  return randomBytes(32).toString('hex');
}
