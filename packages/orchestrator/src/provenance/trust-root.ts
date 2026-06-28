import type { JSONWebKeySet } from 'jose';

/**
 * Derive the JWKS URI for a provenance OIDC issuer. Identical to the Platform's
 * own derivation (`packages/platform/src/dashboard/routes/runs.ts`) so a bundle
 * verified client-side and at ingest resolve the same key set.
 */
export function deriveJwksUri(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`;
}

/**
 * The orchestrator's view of the provenance trust root. The issuer arrives over
 * the `auth.success` connect message for the live process, or from config/env
 * (`KICI_PROVENANCE_ISSUER`) for the CLI backfill which has no live handshake.
 * The JWKS is fetched lazily and cached with a single refetch-on-`kid`-miss.
 */
export interface ProvenanceTrustRoot {
  getIssuer(): string | null;
  getJwks(kid?: string): Promise<JSONWebKeySet | null>;
  setIssuer(issuer: string | null): void;
}

export function createProvenanceTrustRoot(
  opts: { issuer?: string | null; fetchImpl?: typeof fetch; ttlMs?: number } = {},
): ProvenanceTrustRoot {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  let issuer: string | null = opts.issuer ?? null;
  let cache: { jwks: JSONWebKeySet; at: number } | null = null;

  async function fetchJwks(): Promise<JSONWebKeySet | null> {
    if (!issuer) return null;
    try {
      const res = await fetchImpl(deriveJwksUri(issuer));
      if (!res.ok) return null;
      const jwks = (await res.json()) as JSONWebKeySet;
      cache = { jwks, at: Date.now() };
      return jwks;
    } catch {
      return null;
    }
  }

  function hasKid(jwks: JSONWebKeySet | null, kid?: string): boolean {
    if (!kid || !jwks) return true;
    return jwks.keys.some((k) => (k as { kid?: string }).kid === kid);
  }

  return {
    getIssuer: () => issuer,
    getJwks: async (kid) => {
      if (cache && Date.now() - cache.at < ttlMs && hasKid(cache.jwks, kid)) return cache.jwks;
      const jwks = await fetchJwks();
      // A refetch happened above; return whatever the fresh set is even if the
      // requested kid is still absent (the verifier decides; one refetch only).
      return jwks;
    },
    setIssuer: (next) => {
      if (next !== issuer) cache = null;
      issuer = next;
    },
  };
}
