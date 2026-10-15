/**
 * Trust-root resolution for `kici verify-attestation`.
 *
 * The verifier never trusts a token's own `iss`: the issuer and JWKS come
 * out-of-band via `--trust-root`, either
 *
 *  - an **HTTP(S) issuer URL**: discovery at `<url>/.well-known/openid-configuration`
 *    gives `issuer` and `jwks_uri`, then the JWKS is fetched; or
 *  - a **local file** (air-gapped): `{ "issuer": "...", "jwks": { "keys": [...] } }`.
 *
 * Node-specific (`fetch`, `fs`) so the engine verify core stays browser-safe.
 * The engine owns the crypto, so only a structural `JsonWebKeySet` is defined
 * here instead of depending on `jose`.
 */
import { readFile } from 'node:fs/promises';

export interface JsonWebKeySet {
  keys: Record<string, unknown>[];
}

export interface TrustRoot {
  issuer: string;
  jwks: JsonWebKeySet;
}

/** Discovery falls back to the base URL as issuer and `<base>/.well-known/jwks.json`. */
export async function resolveTrustRoot(trustRoot: string): Promise<TrustRoot> {
  if (/^https?:\/\//.test(trustRoot)) {
    const base = trustRoot.replace(/\/+$/, '');
    const disco = await fetchJson(`${base}/.well-known/openid-configuration`);
    const issuer = typeof disco.issuer === 'string' ? disco.issuer : base;
    const jwksUri =
      typeof disco.jwks_uri === 'string' ? disco.jwks_uri : `${base}/.well-known/jwks.json`;
    const jwks = (await fetchJson(jwksUri)) as unknown as JsonWebKeySet;
    return { issuer, jwks };
  }

  const file = JSON.parse(await readFile(trustRoot, 'utf-8')) as {
    issuer?: unknown;
    jwks?: JsonWebKeySet;
  };
  if (typeof file.issuer !== 'string' || !file.jwks || !Array.isArray(file.jwks.keys)) {
    throw new Error('trust-root file must contain { issuer, jwks: { keys: [...] } }');
  }
  return { issuer: file.issuer, jwks: file.jwks };
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}
