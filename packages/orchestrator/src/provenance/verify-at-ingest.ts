import { attestationVerifyStatusSchema, type AttestationVerifyStatus } from '@kici-dev/engine';
import { verifyKiciBundle } from '@kici-dev/engine/provenance/verify';
import { toErrorMessage } from '@kici-dev/shared';
import { decodeProtectedHeader } from 'jose';
import type { CacheStorage } from '../storage/types.js';
import type { ProvenanceTrustRoot } from './trust-root.js';

export interface AttestationVerdict {
  verifyStatus: AttestationVerifyStatus;
  verifyReason: string | null;
  verifiedAt: Date | null;
}

/**
 * Compute the verification verdict for a stored provenance bundle at ingest.
 *
 * Reads the bundle, selects the signing-key set by the identity token's own
 * `kid` (so a kid-miss triggers the trust root's single refetch — a token
 * minted with a freshly-rotated key still verifies against a briefly-stale
 * cached JWKS), then verifies offline.
 *
 * Fail-closed: a missing trust root, unfetchable JWKS, missing storage, or an
 * unreadable bundle all yield `unverifiable` (never silently `verified`). A
 * signing key that is absent from the published JWKS even after the refetch
 * yields `unverifiable` (`signing_key_not_published`) — "couldn't verify", not
 * "proved bad". A bundle that verifies false yields `failed` with the first
 * failure code. Any thrown error is caught and recorded as `unverifiable` —
 * verification never fails the upload.
 */
export async function computeAttestationVerdict(opts: {
  trustRoot: ProvenanceTrustRoot | undefined;
  storage: CacheStorage | undefined;
  storageKey: string;
  logWarn?: (reason: string) => void;
}): Promise<AttestationVerdict> {
  const { trustRoot, storage, storageKey } = opts;
  const status = attestationVerifyStatusSchema.enum;
  try {
    const issuer = trustRoot?.getIssuer() ?? null;
    if (!issuer)
      return {
        verifyStatus: status.unverifiable,
        verifyReason: 'no_issuer_configured',
        verifiedAt: null,
      };
    if (!storage)
      return { verifyStatus: status.unverifiable, verifyReason: 'no_storage', verifiedAt: null };

    // Read + parse the bundle first so we can select the signing key by the
    // identity token's own `kid`: passing it to getJwks(kid) engages the trust
    // root's single kid-miss refetch, so a token minted with a freshly-rotated
    // key still verifies against a briefly-stale cached JWKS.
    const raw = await storage.get(storageKey);
    if (!raw)
      return {
        verifyStatus: status.unverifiable,
        verifyReason: 'bundle_unreadable',
        verifiedAt: null,
      };
    const bundle = JSON.parse(raw.toString('utf8'));

    const idToken = (bundle as { verificationMaterial?: { identityToken?: unknown } })
      ?.verificationMaterial?.identityToken;
    let kid: string | undefined;
    if (typeof idToken === 'string') {
      try {
        kid = decodeProtectedHeader(idToken).kid;
      } catch {
        kid = undefined;
      }
    }

    const jwks = await trustRoot!.getJwks(kid);
    if (!jwks)
      return {
        verifyStatus: status.unverifiable,
        verifyReason: 'jwks_fetch_failed',
        verifiedAt: null,
      };

    // A signing key that is genuinely absent from the published JWKS (even
    // after the kid-miss refetch above) means "couldn't complete verification",
    // not "verification proved it bad" — record unverifiable, not failed.
    if (kid && !jwks.keys.some((k) => (k as { kid?: string }).kid === kid))
      return {
        verifyStatus: status.unverifiable,
        verifyReason: 'signing_key_not_published',
        verifiedAt: null,
      };

    const result = await verifyKiciBundle({
      bundle,
      jwks,
      expectedIssuer: issuer,
    });
    return {
      verifyStatus: result.verified ? status.verified : status.failed,
      verifyReason: result.verified ? null : (result.failures[0] ?? 'verification_failed'),
      verifiedAt: new Date(),
    };
  } catch (err) {
    opts.logWarn?.(toErrorMessage(err));
    return { verifyStatus: status.unverifiable, verifyReason: 'verify_error', verifiedAt: null };
  }
}
