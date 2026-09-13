import crypto, { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Compute SHA-256 hex digest of a string or Buffer. */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Compute SHA-256 hex digest of a file's contents. */
export async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return sha256(content);
}

/**
 * Normalize line endings to LF so hashes computed on different platforms agree.
 *
 * Git for Windows ships with `core.autocrlf=true` in the system gitconfig, so a
 * `git clone` of a Linux-authored repo on a Windows host checks out text files
 * with CRLF in the working tree. The compiler hashed the LF source on Linux,
 * but the agent on Windows reads CRLF and computes a different hash — every
 * dispatch fails with a "lock file is out of date" error even though the
 * semantic content is identical.
 *
 * Applied at the boundaries where source / asset content enters the hash:
 *   - raw workflow source (`.kici/workflows/*.ts`) at hash time, in both the
 *     compiler (lockfile generation) and the agent (drift verification).
 *   - file content portions of the asset digest (`hashFiles` resolution) on
 *     both sides.
 *
 * Standalone `\r` is also collapsed to `\n` for safety against legacy
 * Mac-style endings, though TypeScript source files essentially never carry
 * those in practice.
 */
export function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n?/g, '\n');
}

/** HKDF info string for ECDH-derived AES keys (upload encryption). */
const HKDF_INFO = 'kici-upload-encryption';
/** Empty salt — ECDH output is already high entropy. */
const HKDF_SALT = Buffer.alloc(0);

/**
 * Derive an AES-256 key from an X25519 ECDH shared secret using HKDF.
 *
 * Used by the compiler (encrypt) and agent (decrypt) for tarball uploads.
 * Keys must be DER-encoded (PKCS8 for private, SPKI for public).
 */
export function deriveSharedSecret(ourPrivateKey: Buffer, theirPublicKey: Buffer): Buffer {
  const ourKeyObj = crypto.createPrivateKey({ key: ourPrivateKey, format: 'der', type: 'pkcs8' });
  const theirKeyObj = crypto.createPublicKey({ key: theirPublicKey, format: 'der', type: 'spki' });

  const sharedSecret = crypto.diffieHellman({
    publicKey: theirKeyObj,
    privateKey: ourKeyObj,
  });

  const derivedKey = crypto.hkdfSync('sha256', sharedSecret, HKDF_SALT, HKDF_INFO, 32);

  return Buffer.from(derivedKey);
}

const JSON_IV_LENGTH = 12;
const JSON_AUTH_TAG_LENGTH = 16;

function generateEphemeralKeypair(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })),
  };
}

/** Encrypt bytes for `recipientPublicKey`. Wire: [12B IV][16B tag][ciphertext]. */
export function encryptBytes(
  plaintext: Buffer,
  recipientPublicKey: Buffer,
): { ciphertext: Buffer; senderPublicKey: Buffer } {
  const { publicKey: senderPublicKey, privateKey } = generateEphemeralKeypair();
  const aesKey = deriveSharedSecret(privateKey, recipientPublicKey);
  const iv = crypto.randomBytes(JSON_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ct]), senderPublicKey };
}

/** Inverse of `encryptBytes`. */
export function decryptBytes(
  encrypted: Buffer,
  senderPublicKey: Buffer,
  recipientPrivateKey: Buffer,
): Buffer {
  const aesKey = deriveSharedSecret(recipientPrivateKey, senderPublicKey);
  const iv = encrypted.subarray(0, JSON_IV_LENGTH);
  const tag = encrypted.subarray(JSON_IV_LENGTH, JSON_IV_LENGTH + JSON_AUTH_TAG_LENGTH);
  const ct = encrypted.subarray(JSON_IV_LENGTH + JSON_AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Encrypt a JSON value; returns base64 ciphertext + base64 ephemeral sender pubkey. */
export function encryptJson(
  value: unknown,
  recipientPublicKey: Buffer,
): { ciphertextB64: string; senderPublicKeyB64: string } {
  const { ciphertext, senderPublicKey } = encryptBytes(
    Buffer.from(JSON.stringify(value), 'utf-8'),
    recipientPublicKey,
  );
  return {
    ciphertextB64: ciphertext.toString('base64'),
    senderPublicKeyB64: senderPublicKey.toString('base64'),
  };
}

/** Inverse of `encryptJson`. */
export function decryptJson<T = unknown>(
  ciphertextB64: string,
  senderPublicKey: Buffer,
  recipientPrivateKey: Buffer,
): T {
  const pt = decryptBytes(
    Buffer.from(ciphertextB64, 'base64'),
    senderPublicKey,
    recipientPrivateKey,
  );
  return JSON.parse(pt.toString('utf-8')) as T;
}
