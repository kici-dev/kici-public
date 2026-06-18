/**
 * Trust-root resolution for `kici verify-attestation`.
 *
 * The verifier never blindly trusts a provenance token's own `iss`: the trusted
 * issuer + its JWKS are supplied out-of-band via `--trust-root`. This resolver
 * turns that flag into a concrete `{ issuer, jwks }`:
 *
 *  - an **HTTPS issuer URL** (online): fetch `<url>/.well-known/openid-configuration`,
 *    read its `issuer` + `jwks_uri`, then fetch the JWKS;
 *  - a **local file path** (offline / air-gapped): a self-contained
 *    `{ "issuer": "...", "jwks": { "keys": [...] } }` JSON document, no network.
 *
 * Node-specific (`fetch` + `fs`) so the engine verify core stays pure /
 * browser-safe; the JWKS is passed straight through to the engine, which owns
 * the crypto, so this module defines only a structural `JsonWebKeySet` type
 * rather than depending on `jose`.
 */
import { readFile } from 'node:fs/promises';

/** Structural JWKS shape — the engine verifier owns the real `jose` type. */
export interface JsonWebKeySet {
  keys: Record<string, unknown>[];
}

export interface TrustRoot {
  issuer: string;
  jwks: JsonWebKeySet;
}

/**
 * Resolve `--trust-root`: an HTTPS issuer URL (discovery → `jwks_uri` → JWKS) or
 * a self-contained offline file `{ issuer, jwks }`.
 */
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
