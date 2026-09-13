import { describe, it, expect } from 'vitest';
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createDecipheriv,
} from 'node:crypto';
import { encryptSecretOutputs, type EncryptedSecretOutput } from './secret-encryption.js';

/**
 * Decrypt an encrypted secret output envelope (mirrors orchestrator's decryptSecretOutput).
 *
 * This is the "other side" of the ECDH -- uses the run's private key
 * and the agent's public key to derive the same shared secret.
 */
function decryptEnvelope(envelope: EncryptedSecretOutput, runPrivateKeyDer: Buffer): string {
  const agentPublicKeyDer = Buffer.from(envelope.agentPublicKey, 'base64');

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

  const sharedSecret = diffieHellman({
    privateKey: runPrivateKey,
    publicKey: agentPublicKey,
  });

  const aesKey = Buffer.from(
    hkdfSync('sha256', sharedSecret, Buffer.alloc(0), 'kici-run-secret-outputs', 32),
  );

  const packed = Buffer.from(envelope.encrypted, 'base64');
  const iv = packed.subarray(0, 12);
  const authTag = packed.subarray(12, 28);
  const ciphertext = packed.subarray(28);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

/** Generate a run X25519 key pair (simulates orchestrator side). */
function generateRunKeyPair(): { publicKeyBase64: string; privateKeyDer: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKeyBase64: (publicKey as Buffer).toString('base64'),
    privateKeyDer: privateKey as Buffer,
  };
}

describe('encryptSecretOutputs', () => {
  it('round-trip: encrypt then decrypt produces original value', () => {
    const { publicKeyBase64, privateKeyDer } = generateRunKeyPair();

    const outputs = { API_KEY: 'super-secret-api-key-12345' };
    const encrypted = encryptSecretOutputs(outputs, publicKeyBase64);

    expect(encrypted).toHaveProperty('API_KEY');
    expect(encrypted.API_KEY.agentPublicKey).toBeTruthy();
    expect(encrypted.API_KEY.encrypted).toBeTruthy();

    const decrypted = decryptEnvelope(encrypted.API_KEY, privateKeyDer);
    expect(decrypted).toBe('super-secret-api-key-12345');
  });

  it('returns empty map for empty outputs', () => {
    const { publicKeyBase64 } = generateRunKeyPair();
    const encrypted = encryptSecretOutputs({}, publicKeyBase64);
    expect(encrypted).toEqual({});
  });

  it('encrypts multiple outputs with same agent key pair', () => {
    const { publicKeyBase64, privateKeyDer } = generateRunKeyPair();

    const outputs = {
      DB_PASSWORD: 'pg-secret-123',
      API_TOKEN: 'tok_abc',
      SIGNING_KEY: 'hmac-key-xyz',
    };

    const encrypted = encryptSecretOutputs(outputs, publicKeyBase64);

    // All outputs should share the same agent public key (one ECDH derivation)
    const agentKeys = new Set(Object.values(encrypted).map((e) => e.agentPublicKey));
    expect(agentKeys.size).toBe(1);

    // Each should decrypt correctly
    expect(decryptEnvelope(encrypted.DB_PASSWORD, privateKeyDer)).toBe('pg-secret-123');
    expect(decryptEnvelope(encrypted.API_TOKEN, privateKeyDer)).toBe('tok_abc');
    expect(decryptEnvelope(encrypted.SIGNING_KEY, privateKeyDer)).toBe('hmac-key-xyz');
  });

  it('encrypts and decrypts large value (64KB)', () => {
    const { publicKeyBase64, privateKeyDer } = generateRunKeyPair();

    const largeValue = 'x'.repeat(64 * 1024);
    const encrypted = encryptSecretOutputs({ BIG_SECRET: largeValue }, publicKeyBase64);

    const decrypted = decryptEnvelope(encrypted.BIG_SECRET, privateKeyDer);
    expect(decrypted).toBe(largeValue);
    expect(decrypted.length).toBe(64 * 1024);
  });

  it('produces different ciphertexts for identical values (unique IV per value)', () => {
    const { publicKeyBase64 } = generateRunKeyPair();

    const outputs = { SECRET_A: 'same-value', SECRET_B: 'same-value' };
    const encrypted = encryptSecretOutputs(outputs, publicKeyBase64);

    // Same plaintext should produce different ciphertexts due to unique IVs
    expect(encrypted.SECRET_A.encrypted).not.toBe(encrypted.SECRET_B.encrypted);
  });

  it('generates different agent key pairs across calls', () => {
    const { publicKeyBase64 } = generateRunKeyPair();

    const encrypted1 = encryptSecretOutputs({ KEY: 'val1' }, publicKeyBase64);
    const encrypted2 = encryptSecretOutputs({ KEY: 'val2' }, publicKeyBase64);

    // Different calls should use different ephemeral key pairs
    expect(encrypted1.KEY.agentPublicKey).not.toBe(encrypted2.KEY.agentPublicKey);
  });
});
