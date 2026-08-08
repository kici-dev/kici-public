/**
 * Persistent ES256 signer whose private JWK lives AES-256-GCM-wrapped in the
 * orchestrator DB (`orchestrator_signing_keys.encrypted_private_jwk`), wrapped
 * with the orchestrator's `KICI_SECRET_KEY` master key — the same posture as
 * `scoped_secrets` and the run ephemeral keys. The master key lives in env / KMS
 * and never in the DB, so a DB backup alone cannot sign.
 *
 * The in-memory private key is imported NON-EXTRACTABLE (`extractable: false`),
 * so once loaded the raw private material can never be read back out of the
 * process — the only export path is the public JWK. This is what makes the
 * private key "non-exportable by design" (design spec § A / § H).
 */
import { calculateJwkThumbprint, type JWK } from 'jose';
import { decrypt, deriveKey, encrypt, type EncryptedValue } from '@kici-dev/shared';
import type { Signer } from './signer.js';

/** AAD binding the wrapped private JWK to its purpose (AES-GCM authenticated data). */
export const SIGNING_KEY_AAD = 'orchestrator-signing-key';

/** Encrypt a private JWK with the master key. Returns the base64 wrapped blob. */
export function wrapPrivateJwk(privateJwk: JWK, secretKey: string): string {
  const key = deriveKey(secretKey);
  return encrypt(JSON.stringify(privateJwk), key, 1, SIGNING_KEY_AAD).data;
}

/** Decrypt a wrapped private JWK with the master key. Throws on wrong key / tamper. */
export function unwrapPrivateJwk(encrypted: string, secretKey: string): JWK {
  const value: EncryptedValue = { data: encrypted, keyVersion: 1 };
  const key = deriveKey(secretKey);
  return JSON.parse(decrypt(value, key, SIGNING_KEY_AAD)) as JWK;
}

/** Strip the private member `d` from a private JWK, leaving the public half enriched. */
async function toPublicJwk(privateJwk: JWK): Promise<JWK> {
  if (privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256') {
    throw new Error('signing key must be an EC P-256 JWK (kty=EC, crv=P-256)');
  }
  const publicJwk: JWK = {
    kty: 'EC',
    crv: 'P-256',
    x: privateJwk.x,
    y: privateJwk.y,
    alg: 'ES256',
    use: 'sig',
  };
  publicJwk.kid = await calculateJwkThumbprint(publicJwk, 'sha256');
  return publicJwk;
}

export class DbSigner implements Signer {
  readonly alg = 'ES256' as const;
  readonly signerKind = 'db';
  readonly keyRef = null;

  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly publicJwk: JWK,
  ) {}

  /** Import an EC P-256 private JWK NON-EXTRACTABLE and derive its public half. */
  private static async fromPrivateJwk(privateJwk: JWK): Promise<DbSigner> {
    if (privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256' || !privateJwk.d) {
      throw new Error('signing key must be an EC P-256 private JWK (kty=EC, crv=P-256, d set)');
    }
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      privateJwk as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // NON-EXTRACTABLE — the raw private key never leaves this process
      ['sign'],
    );
    const publicJwk = await toPublicJwk(privateJwk);
    return new DbSigner(privateKey, publicJwk);
  }

  /**
   * Generate a fresh ES256 keypair, wrap the private half with the master key,
   * and return the signer + the artifacts to persist. The generated private key
   * is extractable only long enough to serialize + wrap it; the returned signer
   * re-imports it non-extractable.
   */
  static async generate(secretKey: string): Promise<{
    signer: DbSigner;
    publicJwk: JWK;
    encryptedPrivateJwk: string;
    kid: string;
  }> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JWK;
    const signer = await DbSigner.fromPrivateJwk(privateJwk);
    const publicJwk = await signer.getPublicJwk();
    const encryptedPrivateJwk = wrapPrivateJwk(privateJwk, secretKey);
    return { signer, publicJwk, encryptedPrivateJwk, kid: publicJwk.kid as string };
  }

  /** Reconstruct a signer from a wrapped private JWK. */
  static async fromEncrypted(encryptedPrivateJwk: string, secretKey: string): Promise<DbSigner> {
    const privateJwk = unwrapPrivateJwk(encryptedPrivateJwk, secretKey);
    return DbSigner.fromPrivateJwk(privateJwk);
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    // Web Crypto ECDSA already returns JOSE-raw r||s.
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.privateKey,
      data as unknown as BufferSource,
    );
    return new Uint8Array(sig);
  }

  async getPublicJwk(): Promise<JWK> {
    return this.publicJwk;
  }

  async getKid(): Promise<string> {
    return this.publicJwk.kid as string;
  }
}
