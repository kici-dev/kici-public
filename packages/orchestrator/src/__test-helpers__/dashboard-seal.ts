/**
 * Node stand-in for the dashboard's browser seal, for orchestrator tests:
 * ECDH(X25519) → HKDF-SHA256 with info `kici-dashboard-sealed-write` →
 * AES-256-GCM, framed as `IV || tag || ciphertext`. The ephemeral public key
 * travels as base64 DER-SPKI.
 */
import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type { JWK } from 'jose';
import type { DashboardSealedEnvelope } from '@kici-dev/engine/protocol/messages/dashboard-sealed-write';
import {
  generateDashboardEncryptionKey,
  type GeneratedDashboardEncryptionKey,
} from '../secrets/dashboard-encryption-key.js';
import { decryptPrivateKey } from '../secrets/ephemeral-keys.js';
import type { DashboardContextHandlerDeps } from '../ws/dashboard-context-handler.js';

const DEFAULT_SECRET_KEY = 'a'.repeat(64);

/** Seal `value` to an orchestrator public key given as DER-SPKI. */
export function sealToDer(
  value: string,
  orchPublicKeyDer: Buffer,
): { ephemeralPublicKey: string; encrypted: string } {
  const eph = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: eph.privateKey as Buffer, format: 'der', type: 'pkcs8' }),
    publicKey: createPublicKey({ key: orchPublicKeyDer, format: 'der', type: 'spki' }),
  });
  const aes = Buffer.from(
    hkdfSync('sha256', shared, Buffer.alloc(0), 'kici-dashboard-sealed-write', 32),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aes, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  return {
    ephemeralPublicKey: (eph.publicKey as Buffer).toString('base64'),
    encrypted: Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64'),
  };
}

/** Seal `value` to an orchestrator public key given as a JWK. */
export function sealToJwk(
  value: string,
  orchPublicJwk: JWK,
): { ephemeralPublicKey: string; encrypted: string } {
  const orchPubDer = createPublicKey({ key: orchPublicJwk as never, format: 'jwk' }).export({
    type: 'spki',
    format: 'der',
  }) as Buffer;
  return sealToDer(value, orchPubDer);
}

/** A real key plus the `dashboardEncryption` dep a DashboardContextHandler takes. */
export async function makeDashboardEncryption(secretKey: string = DEFAULT_SECRET_KEY): Promise<{
  key: GeneratedDashboardEncryptionKey;
  dep: NonNullable<DashboardContextHandlerDeps['dashboardEncryption']>;
  seal: (value: string) => DashboardSealedEnvelope;
}> {
  const key = await generateDashboardEncryptionKey(secretKey);
  const dep: NonNullable<DashboardContextHandlerDeps['dashboardEncryption']> = {
    resolve: async () => ({
      activeKid: key.kid,
      publicJwk: key.publicJwk,
      decryptPrivateKeyDer: async (kid: string) =>
        kid === key.kid ? decryptPrivateKey(key.encryptedPrivateKey, secretKey) : null,
    }),
  };
  return {
    key,
    dep,
    seal: (value: string) => ({ keyId: key.kid, ...sealToDer(value, key.publicKeyDer) }),
  };
}
