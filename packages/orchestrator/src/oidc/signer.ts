import { createPublicKey } from 'node:crypto';
import { calculateJwkThumbprint, type JWK } from 'jose';

/**
 * Provider-agnostic signing seam for orchestrator-owned provenance. Verifiers
 * never see which implementation runs (`db` / `aws-kms` / `command`). Ported from
 * the Platform's `oidc/signer.ts` so the two stacks stay byte-compatible.
 */
export interface Signer {
  /** JOSE alg of the produced signatures. */
  readonly alg: 'ES256';
  /** Backend discriminator persisted on the key row (db | aws-kms | command). */
  readonly signerKind: string;
  /** Provider-neutral key locator persisted on the row (KMS ARN, signer command, or null for db). */
  readonly keyRef: string | null;
  /** Sign `data` and return the JOSE-raw (r||s) ES256 signature. */
  sign(data: Uint8Array): Promise<Uint8Array>;
  /** The public key as a JWK (kty EC, crv P-256, alg ES256, use sig, kid). */
  getPublicJwk(): Promise<JWK>;
  /** RFC 7638 thumbprint of the public JWK. */
  getKid(): Promise<string>;
}

/** Convert a DER-encoded ECDSA signature (KMS output) to JOSE-raw r||s of `size`*2 bytes. */
export function derToRawEcdsaSignature(der: Uint8Array, size = 32): Uint8Array {
  let offset = 2; // skip SEQUENCE tag + (short-form) length
  if (der[1] & 0x80) offset += der[1] & 0x7f; // long-form length
  if (der[offset] !== 0x02) throw new Error('invalid DER ECDSA signature: expected INTEGER (r)');
  const rLen = der[offset + 1];
  const r = der.slice(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;
  if (der[offset] !== 0x02) throw new Error('invalid DER ECDSA signature: expected INTEGER (s)');
  const sLen = der[offset + 1];
  const s = der.slice(offset + 2, offset + 2 + sLen);
  const out = new Uint8Array(size * 2);
  out.set(leftPadTrim(r, size), 0);
  out.set(leftPadTrim(s, size), size);
  return out;
}

function leftPadTrim(int: Uint8Array, size: number): Uint8Array {
  let v = int;
  while (v.length > size && v[0] === 0x00) v = v.slice(1); // drop ASN.1 sign byte(s)
  if (v.length > size) throw new Error('ECDSA integer larger than field size');
  const out = new Uint8Array(size);
  out.set(v, size - v.length); // left-pad
  return out;
}

/** Build the public JWK (with kid + alg + use) from a DER SPKI public key (KMS GetPublicKey output). */
export async function derSpkiToPublicJwk(spkiDer: Uint8Array): Promise<JWK> {
  const keyObject = createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' });
  const jwk = keyObject.export({ format: 'jwk' }) as JWK; // { kty:'EC', crv:'P-256', x, y }
  const enriched: JWK = { ...jwk, alg: 'ES256', use: 'sig' };
  enriched.kid = await calculateJwkThumbprint(enriched, 'sha256');
  return enriched;
}
