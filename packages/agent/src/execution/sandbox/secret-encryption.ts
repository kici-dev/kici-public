/**
 * Agent-side encryption for cross-job secret outputs.
 *
 * When a workflow step calls ctx.setSecretOutput(), the plaintext values flow
 * through IPC from the sandbox runner to the agent process. Before sending them
 * over the WebSocket to the orchestrator, the agent encrypts each value using
 * X25519 ECDH + HKDF + AES-256-GCM.
 *
 * Protocol:
 * 1. Generate a fresh ephemeral X25519 key pair (shared across all outputs in one call)
 * 2. ECDH: sharedSecret = agentPrivateKey x runPublicKey
 * 3. HKDF(sha256, sharedSecret, salt='', info='kici-run-secret-outputs', 32) -> AES key
 * 4. AES-256-GCM encrypt each value independently (unique IV per value)
 * 5. Pack as IV (12B) || AuthTag (16B) || Ciphertext, base64 encode
 *
 * The orchestrator decrypts using the run's private key and the agent's public key
 * (via the same ECDH derivation from the other side).
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

/** Encrypted envelope for a single secret output value. */
export interface EncryptedSecretOutput {
  /** Base64-encoded agent ephemeral X25519 public key (DER SPKI). */
  agentPublicKey: string;
  /** Base64-encoded encrypted value: IV (12B) || AuthTag (16B) || Ciphertext. */
  encrypted: string;
}

/**
 * Encrypt secret output values for transport to the orchestrator.
 *
 * Generates a single ephemeral X25519 key pair per call (shared across all outputs
 * in this batch -- one ECDH derivation, unique IV per value).
 *
 * @param outputs - Plaintext secret output key-value pairs
 * @param runPublicKeyBase64 - Base64-encoded run X25519 public key (DER SPKI)
 * @returns Map of key -> encrypted envelope
 */
export function encryptSecretOutputs(
  outputs: Record<string, string>,
  runPublicKeyBase64: string,
): Record<string, EncryptedSecretOutput> {
  const keys = Object.keys(outputs);
  if (keys.length === 0) {
    return {};
  }

  // Generate a fresh ephemeral X25519 key pair for this batch
  const { publicKey: agentPub, privateKey: agentPriv } = generateKeyPairSync('x25519');

  // Export agent public key as base64 DER SPKI for the envelope
  const agentPublicKeyDer = agentPub.export({ type: 'spki', format: 'der' });
  const agentPublicKeyBase64 = Buffer.from(agentPublicKeyDer).toString('base64');

  // Import the run's public key from base64 DER SPKI
  const runPublicKeyDer = Buffer.from(runPublicKeyBase64, 'base64');
  const runPublicKey = createPublicKey({ key: runPublicKeyDer, format: 'der', type: 'spki' });

  // ECDH shared secret
  const sharedSecret = diffieHellman({
    publicKey: runPublicKey,
    privateKey: agentPriv,
  });

  // HKDF to derive AES-256 key
  const aesKey = Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), HKDF_INFO, 32));

  // Encrypt each output value independently (unique IV per value)
  const result: Record<string, EncryptedSecretOutput> = {};

  for (const key of keys) {
    const plaintext = Buffer.from(outputs[key], 'utf-8');
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Pack: IV (12B) || AuthTag (16B) || Ciphertext
    const packed = Buffer.concat([iv, authTag, ciphertext]);

    result[key] = {
      agentPublicKey: agentPublicKeyBase64,
      encrypted: packed.toString('base64'),
    };
  }

  return result;
}
