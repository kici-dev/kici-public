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

/**
 * A trust root backed by the orchestrator's OWN signing keys (Phase 1
 * orchestrator-owned attestations). Verify-at-ingest resolves the key set from
 * the `orchestrator_signing_keys` table so fresh rotations / revocations are
 * reflected immediately, and the issuer is the orchestrator's own configured
 * provenance issuer. The key set is read fresh from the DB each resolve (a cheap
 * read; ingest verification is not hot), so a rotated-in `kid` is always found.
 */
export function provenanceTrustRootFromRepo(
  repo: { listTrusted: () => Promise<{ public_jwk: unknown }[]> },
  issuer: string,
): ProvenanceTrustRoot {
  return {
    getIssuer: () => issuer,
    getJwks: async () => {
      const rows = await repo.listTrusted();
      return { keys: rows.map((r) => r.public_jwk) } as JSONWebKeySet;
    },
    setIssuer: () => {
      // The orchestrator's own issuer is fixed by config; ignore live mutations.
    },
  };
}

export function createProvenanceTrustRoot(
  opts: {
    issuer?: string | null;
    fetchImpl?: typeof fetch;
    ttlMs?: number;
    /**
     * In-process JWKS served directly (no HTTP fetch). Set for the offline local
     * dev plane, whose `kici-local` issuer is not a URL — the plane's own signer
     * is the key source, so a `kici-local` bundle verifies at ingest without a
     * `.well-known/jwks.json` endpoint. When set, discovery/fetch is bypassed.
     */
    staticJwks?: JSONWebKeySet;
  } = {},
): ProvenanceTrustRoot {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  let issuer: string | null = opts.issuer ?? null;
  let cache: { jwks: JSONWebKeySet; at: number } | null = null;

  // Static in-process JWKS (local dev plane): serve it directly, ignore issuer
  // mutations of the key set (the issuer stays `kici-local`), and never fetch.
  if (opts.staticJwks) {
    const staticJwks = opts.staticJwks;
    return {
      getIssuer: () => issuer,
      getJwks: async () => staticJwks,
      setIssuer: (next) => {
        issuer = next;
      },
    };
  }

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
