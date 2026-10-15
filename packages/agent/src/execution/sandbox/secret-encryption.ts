/**
 * Agent-side encryption for cross-job secret outputs. ctx.setSecretOutput()
 * values reach the agent in plaintext over IPC; the agent encrypts each one
 * (X25519 ECDH + HKDF + AES-256-GCM) before it crosses the WebSocket.
 *
 * Protocol:
 * 1. Generate a fresh ephemeral X25519 key pair (shared across all outputs in one call)
 * 2. ECDH: sharedSecret = agentPrivateKey x runPublicKey
 * 3. HKDF(sha256, sharedSecret, salt='', info='kici-run-secret-outputs', 32) -> AES key
 * 4. AES-256-GCM encrypt each value independently (unique IV per value)
 * 5. Pack as IV (12B) || AuthTag (16B) || Ciphertext, base64 encode
 *
 * The orchestrator decrypts with the run's private key and the agent's public
 * key (the same ECDH derivation from the other side).
 */

import {
  generateKeyPairSync,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
} from 'node:crypto';

const IV_LENGTH = 12;
const HKDF_INFO = 'kici-run-secret-outputs';

export interface EncryptedSecretOutput {
  /** Base64-encoded agent ephemeral X25519 public key (DER SPKI). */
  agentPublicKey: string;
  /** Base64-encoded encrypted value: IV (12B) || AuthTag (16B) || Ciphertext. */
  encrypted: string;
}

/**
 * One ephemeral X25519 key pair and ECDH derivation per call, a unique IV per value.
 *
 * @param runPublicKeyBase64 - Base64 run X25519 public key (DER SPKI)
 */
export function encryptSecretOutputs(
  outputs: Record<string, string>,
  runPublicKeyBase64: string,
): Record<string, EncryptedSecretOutput> {
  const keys = Object.keys(outputs);
  if (keys.length === 0) {
    return {};
  }

  const { publicKey: agentPub, privateKey: agentPriv } = generateKeyPairSync('x25519');

  const agentPublicKeyDer = agentPub.export({ type: 'spki', format: 'der' });
  const agentPublicKeyBase64 = Buffer.from(agentPublicKeyDer).toString('base64');

  const runPublicKeyDer = Buffer.from(runPublicKeyBase64, 'base64');
  const runPublicKey = createPublicKey({ key: runPublicKeyDer, format: 'der', type: 'spki' });

  const sharedSecret = diffieHellman({
    publicKey: runPublicKey,
    privateKey: agentPriv,
  });

  const aesKey = Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), HKDF_INFO, 32));

  const result: Record<string, EncryptedSecretOutput> = {};

  for (const key of keys) {
    const plaintext = Buffer.from(outputs[key], 'utf-8');
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const packed = Buffer.concat([iv, authTag, ciphertext]);

    result[key] = {
      agentPublicKey: agentPublicKeyBase64,
      encrypted: packed.toString('base64'),
    };
  }

  return result;
}
