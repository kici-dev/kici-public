import { Hono } from 'hono';
import type { OrchestratorSigningKeyRepo } from '../db/repos/signing-keys-repo.js';
import type { DashboardEncryptionKeyRepo } from '../db/repos/dashboard-encryption-keys-repo.js';

/** OIDC discovery document for the orchestrator provenance issuer. */
export interface OpenidConfiguration {
  issuer: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported: string[];
  response_types_supported: string[];
  subject_types_supported: string[];
  claims_supported: string[];
}

/** Build the `/.well-known/openid-configuration` document for the orchestrator issuer. */
export function buildOpenidConfiguration(issuer: string): OpenidConfiguration {
  const base = issuer.replace(/\/+$/, '');
  return {
    issuer,
    jwks_uri: `${base}/.well-known/jwks.json`,
    id_token_signing_alg_values_supported: ['ES256'],
    response_types_supported: ['id_token'],
    subject_types_supported: ['public'],
    claims_supported: [
      'iss',
      'sub',
      'aud',
      'exp',
      'iat',
      'jti',
      'kici_run_id',
      'kici_job_id',
      'repository',
      'ref',
      'sha',
      'workflow_ref',
    ],
  };
}

export interface ProvenanceOidcRoutesDeps {
  /** The orchestrator's own provenance issuer (config.provenanceSigningIssuer). */
  issuer: string | undefined;
  repo: Pick<OrchestratorSigningKeyRepo, 'listTrusted'>;
  /** Whether orchestrator-owned signing is configured. */
  enabled: boolean;
  /**
   * Dashboard-encryption key repo. When present, the JWKS additionally serves
   * the non-revoked X25519 `use:'enc'` key(s) for browser-sealed dashboard
   * writes (the Verified tier's trust root). Independent of provenance signing.
   */
  dashboardEncryptionRepo?: Pick<DashboardEncryptionKeyRepo, 'listNonRevoked'>;
}

/**
 * Public, unauthenticated OIDC discovery + JWKS endpoints for the orchestrator
 * provenance issuer. Serves ONLY the public key halves (safe to expose).
 *
 * The discovery document returns 503 when orchestrator-owned signing is not
 * configured. The JWKS does not: it also carries the X25519 dashboard-encryption
 * key, which is unrelated to build attestations, and returns 503 only when there
 * is no key of either kind to publish.
 */
export function createProvenanceOidcRoutes(deps: ProvenanceOidcRoutesDeps): Hono {
  const app = new Hono();

  /**
   * The `.well-known` documents are public, unauthenticated key material that a
   * browser fetches cross-origin: the dashboard reads the X25519 encryption key
   * straight from the customer's own origin under the Verified dashboard-write
   * tier. Without this header the browser blocks the response and every
   * encrypted write fails closed.
   *
   * Deliberately scoped to this router only — the orchestrator's admin API must
   * NOT become cross-origin readable. The header is set before the handler runs
   * so error responses carry it too, otherwise a misconfiguration surfaces as an
   * opaque CORS failure instead of its real status.
   *
   * No preflight handling is needed: the fetch is a simple GET with no
   * credentials and no custom request headers.
   */
  app.use('/.well-known/*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    await next();
  });

  app.get('/.well-known/openid-configuration', (c) => {
    // This document IS the provenance issuer's document and cannot be built
    // without an issuer. The Verified dashboard tier does not read it — the
    // browser fetches the JWKS URL directly — so gating it costs that tier
    // nothing.
    if (!deps.enabled || !deps.issuer) return c.json({ error: 'oidc_issuer_not_configured' }, 503);
    return c.json(buildOpenidConfiguration(deps.issuer));
  });

  app.get('/.well-known/jwks.json', async (c) => {
    // A JWKS needs no issuer — it is a key list. Dashboard-encryption keys and
    // build-provenance signing keys are unrelated features and are gated
    // separately: a shared gate would make the Verified dashboard tier require
    // an attestation issuer it has no use for.
    const keys: unknown[] = [];
    if (deps.enabled) {
      const signingRows = await deps.repo.listTrusted();
      for (const r of signingRows) keys.push(r.public_jwk);
    }
    // All non-revoked enc keys are served so a key rotation is seamless.
    if (deps.dashboardEncryptionRepo) {
      const encRows = await deps.dashboardEncryptionRepo.listNonRevoked();
      for (const r of encRows) keys.push(r.public_jwk);
    }
    // Nothing to publish: signing is off (or its key is not provisioned yet)
    // and there is no dashboard-encryption key either.
    if (keys.length === 0) return c.json({ error: 'no_published_keys' }, 503);
    return c.json({ keys });
  });

  return app;
}
