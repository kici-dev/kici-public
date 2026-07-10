/**
 * Compact-JWS assembly for the local dev-signed identity. Mirrors the Platform's
 * `oidc/jwt.ts`: `jose.SignJWT` wants a local KeyLike, but our `LocalSigner`
 * returns the JOSE-raw r||s ES256 signature directly, so we base64url-assemble
 * the compact JWS (`header.payload.signature`) by hand.
 */
import type { LocalSigner } from './local-dev-signer.js';

export interface JwsProtectedHeader {
  alg: 'ES256';
  kid: string;
  typ: 'JWT';
}

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Assemble a compact JWS from a protected header + payload, signed by `signer`. */
export async function signCompactJws(
  signer: LocalSigner,
  protectedHeader: JwsProtectedHeader,
  payload: Record<string, unknown>,
): Promise<string> {
  const signingInput = `${b64url(protectedHeader)}.${b64url(payload)}`;
  const signature = await signer.sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}
