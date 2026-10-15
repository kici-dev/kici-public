import { toErrorMessage } from '@kici-dev/core';

/**
 * The subset of OIDC Provider Metadata (RFC 8414 / OpenID Connect Discovery
 * 1.0) that `pkceFlow` / `deviceFlow` call.
 */
export interface OidcDiscoveryEndpoints {
  /** For sanity-checking the discovery document. */
  issuer: string;
  /** RFC 6749 authorization endpoint (PKCE). */
  authorization_endpoint: string;
  /** RFC 6749 token endpoint (PKCE code exchange + device-flow polling). */
  token_endpoint: string;
  /** RFC 8628 device authorization endpoint. */
  device_authorization_endpoint: string;
}

const cache = new Map<string, OidcDiscoveryEndpoints>();

/** Test-only: clears the per-process cache. */
export function resetDiscoveryCache(): void {
  cache.clear();
}

/**
 * Cached per-process, so a `kici login` makes at most one discovery
 * round-trip. The issuer is a base URL: trailing slashes are stripped and
 * `/.well-known/openid-configuration` appended, which fits a realm-scoped
 * Keycloak issuer (`https://auth.example.com/realms/<realm>`).
 *
 * Throws with an actionable message when discovery is unreachable, returns a
 * non-2xx status, is not JSON, or omits a required field.
 */
export async function discoverOidcEndpoints(issuer: string): Promise<OidcDiscoveryEndpoints> {
  const base = issuer.trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error('[oidc-discovery] issuer is empty');
  }
  const cached = cache.get(base);
  if (cached) return cached;

  const url = `${base}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET' });
  } catch (err) {
    throw new Error(
      `Could not reach IdP discovery at ${url} (${toErrorMessage(err)}). Check KICI_OIDC_ISSUER.`,
    );
  }
  if (!res.ok) {
    throw new Error(`IdP discovery at ${url} returned HTTP ${res.status} ${res.statusText}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`IdP discovery at ${url} returned non-JSON body: ${toErrorMessage(err)}`);
  }

  const parsed = parseEndpoints(body, url);
  cache.set(base, parsed);
  return parsed;
}

function parseEndpoints(body: unknown, url: string): OidcDiscoveryEndpoints {
  if (!body || typeof body !== 'object') {
    throw new Error(`IdP discovery at ${url} returned a non-object payload.`);
  }
  const obj = body as Record<string, unknown>;
  const required: Array<keyof OidcDiscoveryEndpoints> = [
    'issuer',
    'authorization_endpoint',
    'token_endpoint',
    'device_authorization_endpoint',
  ];
  const missing = required.filter((k) => typeof obj[k] !== 'string' || !obj[k]);
  if (missing.length > 0) {
    throw new Error(
      `IdP discovery at ${url} is missing required field(s): ${missing.join(', ')}. ` +
        `The OIDC IdP must advertise authorization_endpoint, token_endpoint, and ` +
        `device_authorization_endpoint via /.well-known/openid-configuration.`,
    );
  }
  return {
    issuer: String(obj.issuer),
    authorization_endpoint: String(obj.authorization_endpoint),
    token_endpoint: String(obj.token_endpoint),
    device_authorization_endpoint: String(obj.device_authorization_endpoint),
  };
}
