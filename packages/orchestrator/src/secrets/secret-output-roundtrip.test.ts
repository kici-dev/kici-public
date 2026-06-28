/**
 * Full round-trip integration test for cross-job secret output encryption.
 *
 * Simulates the entire lifecycle:
 * 1. Orchestrator generates run key pair
 * 2. Orchestrator encrypts private key with secret key (KICI_SECRET_KEY) and stores it
 * 3. Agent encrypts secret outputs using run public key (ECDH)
 * 4. Orchestrator decrypts private key with secret key
 * 5. Orchestrator decrypts secret outputs with run private key
 * 6. Orchestrator re-encrypts plaintext with secret key for storage
 * 7. Orchestrator decrypts from secret key storage for downstream dispatch
 *
 * Uses real crypto (no mocks) to verify the math works end-to-end.
 */
import { describe, it, expect } from 'vitest';
import {
  generateRunKeyPair,
  encryptPrivateKey,
  decryptPrivateKey,
  decryptSecretOutput,
} from './ephemeral-keys.js';
import { encrypt, decrypt, deriveKey } from '@kici-dev/shared';
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
} from 'node:crypto';

/** Simulate agent-side encryption (mirrors packages/agent/src/execution/sandbox/secret-encryption.ts). */
function simulateAgentEncrypt(
  outputs: Record<string, string>,
  runPublicKeyBase64: string,
): Record<string, { agentPublicKey: string; encrypted: string }> {
  const { publicKey: agentPub, privateKey: agentPriv } = generateKeyPairSync('x25519');

  const agentPublicKeyDer = agentPub.export({ type: 'spki', format: 'der' });
  const agentPublicKeyBase64 = Buffer.from(agentPublicKeyDer).toString('base64');

  const runPublicKeyDer = Buffer.from(runPublicKeyBase64, 'base64');
  const runPublicKey = createPublicKey({ key: runPublicKeyDer, format: 'der', type: 'spki' });

  const sharedSecret = diffieHellman({
    publicKey: runPublicKey,
    privateKey: agentPriv,
  });

  const aesKey = Buffer.from(
    hkdfSync('sha256', sharedSecret, Buffer.alloc(0), 'kici-run-secret-outputs', 32),
  );

  const result: Record<string, { agentPublicKey: string; encrypted: string }> = {};
  for (const [key, value] of Object.entries(outputs)) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, authTag, ciphertext]);

    result[key] = {
      agentPublicKey: agentPublicKeyBase64,
      encrypted: packed.toString('base64'),
    };
  }
  return result;
}

describe('secret output full round-trip', () => {
  const secretKey = 'a'.repeat(64); // 32-byte hex secret key

  it('completes the full lifecycle: generate -> encrypt -> agent encrypt -> decrypt -> re-encrypt -> decrypt', () => {
    // 1. Orchestrator generates run key pair
    const { publicKey, privateKey } = generateRunKeyPair();
    const runPublicKeyBase64 = publicKey.toString('base64');

    // 2. Orchestrator encrypts and stores private key
    const encryptedPrivKey = encryptPrivateKey(privateKey, secretKey);

    // 3. Agent encrypts secret outputs using run public key
    const agentOutputs = simulateAgentEncrypt(
      {
        DATABASE_URL: 'postgres://user:pass@host:5432/db',
        API_TOKEN: 'sk-1234567890abcdef',
        EMPTY_SECRET: '',
      },
      runPublicKeyBase64,
    );

    // 4. Orchestrator decrypts private key with secret key
    const recoveredPrivKey = decryptPrivateKey(encryptedPrivKey, secretKey);
    expect(recoveredPrivKey.equals(privateKey)).toBe(true);

    // 5. Orchestrator decrypts each secret output
    const decryptedOutputs: Record<string, string> = {};
    for (const [key, envelope] of Object.entries(agentOutputs)) {
      decryptedOutputs[key] = decryptSecretOutput(envelope, recoveredPrivKey);
    }

    expect(decryptedOutputs).toEqual({
      DATABASE_URL: 'postgres://user:pass@host:5432/db',
      API_TOKEN: 'sk-1234567890abcdef',
      EMPTY_SECRET: '',
    });

    // 6. Re-encrypt with secret key for storage (simulating secret-output-store pattern)
    const derivedKey = deriveKey(secretKey);
    const storedValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(decryptedOutputs)) {
      const encrypted = encrypt(value, derivedKey, 1, `secret-output:${key}`);
      storedValues[key] = encrypted.data;
    }

    // 7. Decrypt from secret key storage for downstream dispatch
    for (const [key, encryptedData] of Object.entries(storedValues)) {
      const decrypted = decrypt(
        { data: encryptedData, keyVersion: 1 },
        derivedKey,
        `secret-output:${key}`,
      );
      expect(decrypted).toBe(decryptedOutputs[key]);
    }
  });

  it('handles multiple agents encrypting for the same run', () => {
    const { publicKey, privateKey } = generateRunKeyPair();
    const runPublicKeyBase64 = publicKey.toString('base64');

    // Agent 1 encrypts
    const agent1Outputs = simulateAgentEncrypt(
      { TOKEN_A: 'value-from-agent-1' },
      runPublicKeyBase64,
    );

    // Agent 2 encrypts (different ephemeral key pair)
    const agent2Outputs = simulateAgentEncrypt(
      { TOKEN_B: 'value-from-agent-2' },
      runPublicKeyBase64,
    );

    // Different agent public keys (different ephemeral pairs)
    expect(agent1Outputs['TOKEN_A'].agentPublicKey).not.toBe(
      agent2Outputs['TOKEN_B'].agentPublicKey,
    );

    // Both decrypt correctly with the same run private key
    expect(decryptSecretOutput(agent1Outputs['TOKEN_A'], privateKey)).toBe('value-from-agent-1');
    expect(decryptSecretOutput(agent2Outputs['TOKEN_B'], privateKey)).toBe('value-from-agent-2');
  });

  it('rejects decryption with wrong run private key', () => {
    const run1 = generateRunKeyPair();
    const run2 = generateRunKeyPair();

    const agentOutputs = simulateAgentEncrypt(
      { SECRET: 'cross-run-attack' },
      run1.publicKey.toString('base64'),
    );

    // Attempting to decrypt with run2's private key should fail
    expect(() => decryptSecretOutput(agentOutputs['SECRET'], run2.privateKey)).toThrow();
  });

  it('handles large secret values', () => {
    const { publicKey, privateKey } = generateRunKeyPair();
    const runPublicKeyBase64 = publicKey.toString('base64');

    // 10KB secret value
    const largeValue = 'x'.repeat(10240);
    const agentOutputs = simulateAgentEncrypt({ LARGE: largeValue }, runPublicKeyBase64);

    const decrypted = decryptSecretOutput(agentOutputs['LARGE'], privateKey);
    expect(decrypted).toBe(largeValue);
  });
});
