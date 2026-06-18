/**
 * Ephemeral key pair management for cross-job secret output encryption.
 *
 * Each execution run gets an X25519 key pair:
 * - The public key is sent to agents so they can encrypt secret outputs
 * - The private key is stored encrypted with the orchestrator secret key (KICI_SECRET_KEY)
 * - Agents encrypt outputs with ECDH (agent ephemeral key + run public key)
 * - The orchestrator decrypts with the run private key
 */
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createDecipheriv,
} from 'node:crypto';
import { encrypt, decrypt, deriveKey, type EncryptedValue } from './crypto.js';

/** AAD string used when encrypting/decrypting private keys with secret key. */
const PRIVATE_KEY_AAD = 'ephemeral-private-key';

/** HKDF info string for deriving AES key from ECDH shared secret. */
const HKDF_INFO = 'kici-run-secret-outputs';

/**
 * Generate an X25519 key pair for a run.
 *
 * @returns publicKey and privateKey as DER-encoded Buffers
 */
export function generateRunKeyPair(): { publicKey: Buffer; privateKey: Buffer } {
  const pair = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: pair.publicKey as Buffer,
    privateKey: pair.privateKey as Buffer,
  };
}

/**
 * Encrypt a run's private key using the orchestrator secret key (KICI_SECRET_KEY).
 *
 * @param privateKey - DER-encoded private key Buffer
 * @param secretKey - Orchestrator secret key (hex or base64 string)
 * @returns Base64-encoded encrypted data (IV || AuthTag || Ciphertext)
 */
export function encryptPrivateKey(privateKey: Buffer, secretKey: string): string {
  const key = deriveKey(secretKey);
  const encrypted = encrypt(privateKey.toString('base64'), key, 1, PRIVATE_KEY_AAD);
  return encrypted.data;
}

/**
 * Decrypt a run's private key using the orchestrator secret key (KICI_SECRET_KEY).
 *
 * @param encryptedData - Base64-encoded encrypted private key
 * @param secretKey - Orchestrator secret key (hex or base64 string)
 * @returns DER-encoded private key Buffer
 * @throws If decryption fails
 */
export function decryptPrivateKey(encryptedData: string, secretKey: string): Buffer {
  const encryptedValue: EncryptedValue = { data: encryptedData, keyVersion: 1 };
  const key = deriveKey(secretKey);
  const decrypted = decrypt(encryptedValue, key, PRIVATE_KEY_AAD);
  return Buffer.from(decrypted, 'base64');
}

/**
 * Decrypt a secret output envelope produced by an agent.
 *
 * The agent encrypts with:
 * 1. Generate ephemeral X25519 key pair
 * 2. ECDH: shared secret = agentPrivateKey x runPublicKey
 * 3. HKDF(sha256, sharedSecret, salt='', info='kici-run-secret-outputs', 32)
 * 4. AES-256-GCM encrypt with derived key
 *
 * We decrypt with:
 * 1. ECDH: shared secret = runPrivateKey x agentPublicKey
 * 2. Same HKDF derivation
 * 3. AES-256-GCM decrypt
 *
 * @param envelope - { agentPublicKey: base64, encrypted: base64 (IV||AuthTag||Ciphertext) }
 * @param runPrivateKeyDer - DER-encoded run private key Buffer
 * @returns Decrypted plaintext string
 */
export function decryptSecretOutput(
  envelope: { agentPublicKey: string; encrypted: string },
  runPrivateKeyDer: Buffer,
): string {
  const agentPublicKeyDer = Buffer.from(envelope.agentPublicKey, 'base64');

  // Import keys as KeyObjects
  const runPrivateKey = createPrivateKey({
    key: runPrivateKeyDer,
    format: 'der',
    type: 'pkcs8',
  });
  const agentPublicKey = createPublicKey({
    key: agentPublicKeyDer,
    format: 'der',
    type: 'spki',
  });

  // ECDH shared secret
  const sharedSecret = diffieHellman({
    privateKey: runPrivateKey,
    publicKey: agentPublicKey,
  });

  // HKDF to derive AES-256 key
  const aesKey = Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), HKDF_INFO, 32));

  // Unpack: IV (12) || AuthTag (16) || Ciphertext
  const packed = Buffer.from(envelope.encrypted, 'base64');
  const IV_LENGTH = 12;
  const TAG_LENGTH = 16;

  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid encrypted envelope: too short');
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}
