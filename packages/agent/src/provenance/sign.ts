/**
 * Ephemeral-key DSSE signer for KiCI provenance (Mode A).
 *
 * Generates a fresh in-process ES256 keypair (never persisted), DSSE-signs the
 * PAE of the statement bytes with the private half, and returns the envelope
 * plus the public JWK. The public key travels in the bundle so the verifier can
 * check the signature; the key needs no separate trust root because the bundle's
 * identity JWT (verified against the Platform JWKS) anchors the whole package.
 */
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';
import { buildDsseEnvelope, dssePae, type DsseEnvelope } from '@kici-dev/engine/provenance/dsse';

export interface SignedStatement {
  envelope: DsseEnvelope;
  /** Ephemeral public key as a JWK, with `kid` = its RFC 7638 thumbprint. */
  publicJwk: JWK & { kid: string };
}

/** DSSE-sign `statementBytes` with a fresh in-process ephemeral ES256 key. */
export async function signStatementDsse(
  payloadType: string,
  statementBytes: Uint8Array,
): Promise<SignedStatement> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';
  const kid = await calculateJwkThumbprint(publicJwk, 'sha256');
  publicJwk.kid = kid;

  const pae = dssePae(payloadType, statementBytes);
  // Web Crypto ECDSA returns the IEEE P1363 raw r||s signature (64 bytes for
  // P-256) — the same encoding the bundled public JWK verifies with.
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey as unknown as CryptoKey,
      pae as BufferSource,
    ),
  );

  const envelope = buildDsseEnvelope(payloadType, statementBytes, [{ keyid: kid, sig }]);
  return { envelope, publicJwk: publicJwk as JWK & { kid: string } };
}
