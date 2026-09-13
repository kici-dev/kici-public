import { Hono } from 'hono';
import type { JSONWebKeySet } from 'jose';
import { KICI_PROVENANCE_AUDIENCE } from '@kici-dev/engine/provenance/bundle';
import { verifyKiciBundle } from '@kici-dev/engine/provenance/verify';
import type { OrchestratorSigningKeyRepo } from '../db/repos/signing-keys-repo.js';

export interface VerifyAttestationRoutesDeps {
  /** The orchestrator's own provenance issuer (config.provenanceSigningIssuer). */
  issuer: string | undefined;
  repo: Pick<OrchestratorSigningKeyRepo, 'listTrusted'>;
  /** Whether orchestrator-owned signing is configured. */
  enabled: boolean;
}

/**
 * Native online verify endpoint: a third party POSTs a bundle and the
 * orchestrator verifies it against its LIVE key set (fresh rotations /
 * revocations included), returning a structured verdict. No Platform involved.
 *
 * The token `iss` is ALWAYS pinned out-of-band to the orchestrator's configured
 * issuer — the bundle can never name its own trusted issuer. Never throws on a
 * verification failure (returns `verified:false`); the shared engine core owns
 * all crypto (ES256 pinned; no alg-confusion / alg:none).
 */
export function createVerifyAttestationRoutes(deps: VerifyAttestationRoutesDeps): Hono {
  const app = new Hono();

  app.post('/v1/verify-attestation', async (c) => {
    if (!deps.enabled || !deps.issuer) {
      return c.json({ error: 'provenance_signing_not_configured' }, 503);
    }
    let body: { bundle?: unknown; audience?: string; digest?: { alg: string; hex: string } };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (body.bundle === undefined) {
      return c.json({ error: 'bundle_required' }, 400);
    }
    const rows = await deps.repo.listTrusted();
    const jwks: JSONWebKeySet = { keys: rows.map((r) => r.public_jwk as Record<string, unknown>) };
    const result = await verifyKiciBundle({
      bundle: body.bundle,
      jwks,
      expectedIssuer: deps.issuer,
      expectedAudience: body.audience ?? KICI_PROVENANCE_AUDIENCE,
      expectedDigest: body.digest,
    });
    return c.json(result);
  });

  return app;
}
