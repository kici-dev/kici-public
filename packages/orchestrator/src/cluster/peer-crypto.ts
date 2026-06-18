/**
 * ECDH key exchange and session encryption for peer-to-peer channels.
 *
 * Uses X25519 for key agreement and AES-256-GCM for message encryption.
 * Session keys are derived via HKDF-SHA256 from the ECDH shared secret
 * and a caller-provided nonce (to ensure per-session uniqueness).
 *
 * Wire format for encrypted messages (base64 encoded):
 *   IV (12 bytes) || AuthTag (16 bytes) || Ciphertext
 */
import {
  generateKeyPairSync,
  diffieHellman,
  createPublicKey,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type KeyObject,
} from 'node:crypto';

/** HKDF info string binding derived keys to this protocol version. */
const HKDF_INFO = 'kici-peer-v1';

/** IV length for AES-256-GCM. */
const IV_LEN = 12;

/** Authentication tag length for AES-256-GCM. */
const TAG_LEN = 16;

/**
 * An X25519 key pair for ECDH key exchange.
 * The public key is DER SPKI-encoded for wire transport.
 */
export interface EcdhKeyPair {
  /** DER SPKI-encoded X25519 public key. */
  publicKey: Buffer;
  /** X25519 private key object (not exported to wire). */
  privateKey: KeyObject;
}

/**
 * Generate a new X25519 key pair for ECDH key exchange.
 *
 * @returns Key pair with DER SPKI public key and KeyObject private key
 */
export function generateEcdhKeyPair(): EcdhKeyPair {
  const pair = generateKeyPairSync('x25519');
  const publicKeyDer = pair.publicKey.export({ type: 'spki', format: 'der' });
  return { publicKey: publicKeyDer as Buffer, privateKey: pair.privateKey };
}

/**
 * Derive a 32-byte AES-256 session key from an ECDH key exchange.
 *
 * Performs X25519 Diffie-Hellman, then derives the session key via
 * HKDF-SHA256 with the provided nonce as salt.
 *
 * @param localPrivateKey - This node's X25519 private key
 * @param remotePubKeyDer - Remote node's DER SPKI-encoded X25519 public key
 * @param nonce - Random nonce (used as HKDF salt for per-session uniqueness)
 * @returns 32-byte session key suitable for AES-256-GCM
 */
export function deriveSessionKey(
  localPrivateKey: KeyObject,
  remotePubKeyDer: Buffer,
  nonce: Buffer,
): Buffer {
  const remotePublicKey = createPublicKey({
    key: remotePubKeyDer,
    format: 'der',
    type: 'spki',
  });
  const shared = diffieHellman({ privateKey: localPrivateKey, publicKey: remotePublicKey });
  return Buffer.from(hkdfSync('sha256', shared, nonce, HKDF_INFO, 32));
}

/**
 * Encrypt a plaintext message with a session key using AES-256-GCM.
 *
 * @param plaintext - The message to encrypt
 * @param sessionKey - 32-byte session key from deriveSessionKey
 * @returns Base64-encoded string: IV (12) || AuthTag (16) || Ciphertext
 */
export function encryptMessage(plaintext: string, sessionKey: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', sessionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a message encrypted with encryptMessage.
 *
 * @param encrypted - Base64-encoded string: IV (12) || AuthTag (16) || Ciphertext
 * @param sessionKey - 32-byte session key (must match the key used for encryption)
 * @returns Decrypted plaintext string
 * @throws If the session key is wrong or the ciphertext has been tampered with
 */
export function decryptMessage(encrypted: string, sessionKey: Buffer): string {
  const packed = Buffer.from(encrypted, 'base64');
  if (packed.length < IV_LEN + TAG_LEN) {
    throw new Error('Invalid encrypted message: too short');
  }
  const iv = packed.subarray(0, IV_LEN);
  const authTag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = packed.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', sessionKey, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
