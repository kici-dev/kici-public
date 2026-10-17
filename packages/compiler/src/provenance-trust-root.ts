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

export interface ResolvedTrustRoot {
  issuer: string;
  jwks: JsonWebKeySet;
  /** One line per plain-HTTP URL accepted because `allowInsecure` was set. */
  warnings: string[];
}

/** Redirect hops a trust-root fetch follows, each one transport-checked. */
const MAX_TRUST_ROOT_REDIRECTS = 5;

/** The flag that accepts a plain-HTTP trust root on a host that is not loopback. */
const ALLOW_INSECURE_TRUST_ROOT_FLAG = '--allow-insecure-trust-root';

/**
 * The transport a trust-root URL is fetched over. Loopback means the parsed
 * hostname is `localhost`, an IPv4 address in 127.0.0.0/8, or `[::1]`; a name
 * that only starts with one (`localhost.evil.com`, `127.0.0.1.nip.io`) is not.
 */
export function trustRootTransportVerdict(
  url: string,
): 'https' | 'loopback-http' | 'insecure-http' {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return 'https';
  const host = parsed.hostname;
  const loopback =
    host === 'localhost' ||
    host === '[::1]' ||
    /^127\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)$/.test(
      host,
    );
  return loopback ? 'loopback-http' : 'insecure-http';
}

/**
 * A trust root refused because a key set fetched from it would travel over
 * plain HTTP to a host that is not loopback.
 */
export class InsecureTrustRootError extends Error {
  constructor(readonly url: string) {
    super(
      `refusing trust root URL ${url}: it is plain HTTP on a host that is not loopback, so a ` +
        `network attacker can replace the signing keys. Use an https:// trust root, or a ` +
        `trust-root file from \`kici-admin signing-key export --public\`. To accept the risk, ` +
        `pass ${ALLOW_INSECURE_TRUST_ROOT_FLAG}.`,
    );
    this.name = 'InsecureTrustRootError';
  }
}

function insecureWarning(url: string): string {
  return (
    `trust root URL ${url} is plain HTTP on a host that is not loopback; a network ` +
    `attacker can replace the signing keys (accepted by ${ALLOW_INSECURE_TRUST_ROOT_FLAG})`
  );
}

/**
 * Discovery falls back to the base URL as issuer and `<base>/.well-known/jwks.json`.
 *
 * Every URL a key set travels over is checked before it is fetched: the base,
 * the discovery's `jwks_uri`, and every redirect hop, followed by hand so a
 * plain-HTTP hop in the middle of a chain that ends on `https` is seen too. A plain-HTTP URL on a host
 * that is not loopback throws {@link InsecureTrustRootError}, unless
 * `allowInsecure` is set, which records a warning instead.
 */
export async function resolveTrustRoot(
  trustRoot: string,
  opts: { allowInsecure?: boolean } = {},
): Promise<ResolvedTrustRoot> {
  if (/^https?:\/\//.test(trustRoot)) {
    const warnings: string[] = [];
    const check = (url: string): void => {
      if (trustRootTransportVerdict(url) !== 'insecure-http') return;
      if (!opts.allowInsecure) throw new InsecureTrustRootError(url);
      if (!warnings.includes(insecureWarning(url))) warnings.push(insecureWarning(url));
    };
    const fetchChecked = async (url: string): Promise<Record<string, unknown>> => {
      let current = url;
      for (let hop = 0; hop <= MAX_TRUST_ROOT_REDIRECTS; hop++) {
        check(current);
        const res = await fetch(current, { redirect: 'manual' });
        // A runtime that follows redirects anyway reports where it ended up.
        if (res.url && res.url !== current) check(res.url);
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (location) {
          current = new URL(location, current).toString();
          continue;
        }
        if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
        return (await res.json()) as Record<string, unknown>;
      }
      throw new Error(`failed to fetch ${url}: more than ${MAX_TRUST_ROOT_REDIRECTS} redirects`);
    };

    const base = trustRoot.replace(/\/+$/, '');
    const disco = await fetchChecked(`${base}/.well-known/openid-configuration`);
    const issuer = typeof disco.issuer === 'string' ? disco.issuer : base;
    const jwksUri =
      typeof disco.jwks_uri === 'string' ? disco.jwks_uri : `${base}/.well-known/jwks.json`;
    const jwks = (await fetchChecked(jwksUri)) as unknown as JsonWebKeySet;
    return { issuer, jwks, warnings };
  }

  const file = JSON.parse(await readFile(trustRoot, 'utf-8')) as {
    issuer?: unknown;
    jwks?: JsonWebKeySet;
  };
  if (typeof file.issuer !== 'string' || !file.jwks || !Array.isArray(file.jwks.keys)) {
    throw new Error('trust-root file must contain { issuer, jwks: { keys: [...] } }');
  }
  return { issuer: file.issuer, jwks: file.jwks, warnings: [] };
}
