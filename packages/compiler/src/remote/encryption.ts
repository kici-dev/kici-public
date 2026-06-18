import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { deriveSharedSecret } from '@kici-dev/core';

/**
 * Wire format for encrypted tarballs:
 * [12-byte IV][16-byte auth tag][ciphertext]
 *
 * Uses AES-256-GCM with X25519 ECDH key exchange.
 * Same pattern as engine/src/secrets/crypto.ts.
 */

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// Re-export for consumers that import from this module
export { deriveSharedSecret };

/**
 * Generate an ephemeral X25519 keypair.
 * Keys are exported as DER buffers for compact wire format.
 */
export function generateEphemeralKeypair(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');

  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })),
  };
}

/**
 * Encrypt a tarball file using X25519 ECDH + AES-256-GCM.
 *
 * Generates an ephemeral CLI keypair, derives a shared secret with the
 * orchestrator's public key, and encrypts the tarball.
 *
 * Wire format: [12-byte IV][16-byte auth tag][ciphertext]
 *
 * @returns The encrypted file path and the CLI's ephemeral public key
 *          (the agent needs this to derive the same shared secret for decryption).
 */
export async function encryptTarball(
  tarballPath: string,
  orchestratorPublicKey: Buffer,
): Promise<{ encryptedPath: string; cliPublicKey: Buffer }> {
  const { publicKey: cliPublicKey, privateKey: cliPrivateKey } = generateEphemeralKeypair();

  const aesKey = deriveSharedSecret(cliPrivateKey, orchestratorPublicKey);

  const plaintext = await fs.readFile(tarballPath);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Wire format: [IV][auth tag][ciphertext]
  const encrypted = Buffer.concat([iv, authTag, ciphertext]);

  const encryptedPath = `${tarballPath}.enc`;
  await fs.writeFile(encryptedPath, encrypted);

  return { encryptedPath, cliPublicKey };
}

/**
 * Decrypt an encrypted tarball using X25519 ECDH + AES-256-GCM.
 *
 * Derives the same shared secret from the orchestrator's private key
 * and the CLI's ephemeral public key.
 *
 * @returns The path to the decrypted file (encrypted path with .enc suffix removed).
 */
export async function decryptTarball(
  encryptedPath: string,
  cliPublicKey: Buffer,
  orchestratorPrivateKey: Buffer,
): Promise<string> {
  const aesKey = deriveSharedSecret(orchestratorPrivateKey, cliPublicKey);

  const encrypted = await fs.readFile(encryptedPath);

  const iv = encrypted.subarray(0, IV_LENGTH);
  const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = encrypted.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Remove .enc suffix for output path
  const decryptedPath = encryptedPath.endsWith('.enc')
    ? encryptedPath.slice(0, -4)
    : `${encryptedPath}.dec`;

  await fs.writeFile(decryptedPath, decrypted);

  return decryptedPath;
}
