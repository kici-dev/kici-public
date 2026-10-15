/**
 * AES-256-GCM secret encryption. The AAD (typically "contextId:keyName") binds
 * a ciphertext to its location, preventing cross-context secret swaps.
 *
 * Wire format (base64 encoded): IV (12 bytes) || AuthTag (16 bytes) || Ciphertext
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const IV_LENGTH = 12;

const TAG_LENGTH = 16;

const ALGO = 'aes-256-gcm';

export interface EncryptedValue {
  /** Base64-encoded IV || AuthTag || Ciphertext. */
  data: string;
  keyVersion: number;
}

/**
 * @param key - 32-byte encryption key
 * @param aad - Additional authenticated data (e.g., "contextId:keyName")
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

  const packed = Buffer.concat([iv, authTag, encrypted]);

  return {
    data: packed.toString('base64'),
    keyVersion,
  };
}

/**
 * Decrypt with AAD verification; `key` and `aad` must match the ones used to encrypt.
 *
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
 * Derive a 32-byte key from a 64-character hex string (e.g. from
 * generateMasterKey()) or a base64-encoded 32-byte value.
 *
 * @throws If the derived key is not exactly 32 bytes
 */
export function deriveKey(input: string): Buffer {
  let key: Buffer;

  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    key = Buffer.from(input, 'hex');
  } else {
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

/** Generate a random 32-byte master key as 64 hex characters, suitable for KICI_SECRET_KEY. */
export function generateMasterKey(): string {
  return randomBytes(32).toString('hex');
}
