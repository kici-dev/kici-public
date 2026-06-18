/**
 * Tests for ephemeral key pair management.
 *
 * Covers:
 * - X25519 key pair generation
 * - Private key encrypt/decrypt round-trip with secret key
 * - Wrong key rejection
 * - decryptSecretOutput ECDH + HKDF + AES-GCM round-trip
 */
import { describe, it, expect } from 'vitest';
import {
  generateRunKeyPair,
  encryptPrivateKey,
  decryptPrivateKey,
  decryptSecretOutput,
} from './ephemeral-keys.js';
import { generateKeyPairSync, diffieHellman, hkdfSync, randomBytes } from 'node:crypto';
import { createCipheriv } from 'node:crypto';

// Helper to simulate agent-side encryption (what the agent would do)
function agentEncryptSecret(
  value: string,
  runPublicKeyDer: Buffer,
): { agentPublicKey: string; encrypted: string } {
  // Generate agent ephemeral key pair
  const agentKeyPair = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  // Derive shared secret via ECDH
  const agentPrivateKeyObj = require('node:crypto').createPrivateKey({
    key: agentKeyPair.privateKey as Buffer,
    format: 'der',
    type: 'pkcs8',
  });
  const runPublicKeyObj = require('node:crypto').createPublicKey({
    key: runPublicKeyDer,
    format: 'der',
    type: 'spki',
  });

  const sharedSecret = diffieHellman({
    privateKey: agentPrivateKeyObj,
    publicKey: runPublicKeyObj,
  });

  // HKDF to derive AES key
  const aesKey = Buffer.from(
    hkdfSync('sha256', sharedSecret, Buffer.alloc(0), 'kici-run-secret-outputs', 32),
  );

  // AES-256-GCM encrypt
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: IV || AuthTag || Ciphertext (same format as crypto.ts)
  const packed = Buffer.concat([iv, authTag, encrypted]);

  return {
    agentPublicKey: (agentKeyPair.publicKey as Buffer).toString('base64'),
    encrypted: packed.toString('base64'),
  };
}

describe('ephemeral keys', () => {
  const testSecretKey = 'a'.repeat(64); // 64 hex chars = 32 bytes

  describe('generateRunKeyPair', () => {
    it('produces publicKey and privateKey as Buffers', () => {
      const pair = generateRunKeyPair();
      expect(pair.publicKey).toBeInstanceOf(Buffer);
      expect(pair.privateKey).toBeInstanceOf(Buffer);
    });

    it('generates non-empty keys', () => {
      const pair = generateRunKeyPair();
      expect(pair.publicKey.length).toBeGreaterThan(0);
      expect(pair.privateKey.length).toBeGreaterThan(0);
    });

    it('generates unique key pairs', () => {
      const a = generateRunKeyPair();
      const b = generateRunKeyPair();
      expect(a.publicKey.equals(b.publicKey)).toBe(false);
      expect(a.privateKey.equals(b.privateKey)).toBe(false);
    });
  });

  describe('encryptPrivateKey / decryptPrivateKey', () => {
    it('round-trips private key with correct secret key', () => {
      const pair = generateRunKeyPair();
      const encrypted = encryptPrivateKey(pair.privateKey, testSecretKey);
      expect(typeof encrypted).toBe('string');

      const decrypted = decryptPrivateKey(encrypted, testSecretKey);
      expect(decrypted.equals(pair.privateKey)).toBe(true);
    });

    it('produces different ciphertexts for same key (unique IVs)', () => {
      const pair = generateRunKeyPair();
      const a = encryptPrivateKey(pair.privateKey, testSecretKey);
      const b = encryptPrivateKey(pair.privateKey, testSecretKey);
      expect(a).not.toBe(b);
    });

    it('throws with wrong secret key', () => {
      const pair = generateRunKeyPair();
      const encrypted = encryptPrivateKey(pair.privateKey, testSecretKey);
      const wrongKey = 'b'.repeat(64);
      expect(() => decryptPrivateKey(encrypted, wrongKey)).toThrow();
    });
  });

  describe('decryptSecretOutput', () => {
    it('decrypts agent-encrypted envelope using run private key', () => {
      const pair = generateRunKeyPair();
      const secretValue = 'my-secret-api-key-12345';

      const envelope = agentEncryptSecret(secretValue, pair.publicKey);
      const decrypted = decryptSecretOutput(envelope, pair.privateKey);
      expect(decrypted).toBe(secretValue);
    });

    it('decrypts empty string', () => {
      const pair = generateRunKeyPair();
      const envelope = agentEncryptSecret('', pair.publicKey);
      const decrypted = decryptSecretOutput(envelope, pair.privateKey);
      expect(decrypted).toBe('');
    });

    it('decrypts unicode values', () => {
      const pair = generateRunKeyPair();
      const secretValue = 'unicode secret value for verification';
      const envelope = agentEncryptSecret(secretValue, pair.publicKey);
      const decrypted = decryptSecretOutput(envelope, pair.privateKey);
      expect(decrypted).toBe(secretValue);
    });

    it('throws with wrong run private key', () => {
      const pair = generateRunKeyPair();
      const otherPair = generateRunKeyPair();
      const envelope = agentEncryptSecret('secret', pair.publicKey);

      // Use a different run's private key -- ECDH shared secret will be wrong
      expect(() => decryptSecretOutput(envelope, otherPair.privateKey)).toThrow();
    });
  });
});
