import { attestationVerifyStatusSchema, type AttestationVerifyStatus } from '@kici-dev/engine';
import { verifyKiciBundle } from '@kici-dev/engine/provenance/verify';
import { toErrorMessage } from '@kici-dev/shared';
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
 * Fail-closed: a missing trust root, unfetchable JWKS, missing storage, or an
 * unreadable bundle all yield `unverifiable` (never silently `verified`). A
 * bundle that verifies false yields `failed` with the first failure code. Any
 * thrown error is caught and recorded as `unverifiable` — verification never
 * fails the upload.
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

    const jwks = await trustRoot!.getJwks();
    if (!jwks)
      return {
        verifyStatus: status.unverifiable,
        verifyReason: 'jwks_fetch_failed',
        verifiedAt: null,
      };

    const raw = await storage.get(storageKey);
    if (!raw)
      return {
        verifyStatus: status.unverifiable,
        verifyReason: 'bundle_unreadable',
        verifiedAt: null,
      };

    const result = await verifyKiciBundle({
      bundle: JSON.parse(raw.toString('utf8')),
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
