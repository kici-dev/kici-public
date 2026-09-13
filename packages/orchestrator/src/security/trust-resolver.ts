/**
 * Ref-based trust: may this git ref reach shared state and real secrets?
 *
 * Trusted ⇔ the ref lives in the base repo (any same-repo push or PR —
 * only a write-or-higher contributor can put a ref there). Untrusted ⇔ the
 * ref comes from a fork. Resolved locally from the webhook payload; no
 * provider API call, no identity lookup.
 *
 * The stored/wire tier vocabulary keeps 'unknown' as the name for
 * "untrusted" and 'trusted' for "trusted"; 'known' is legacy vocabulary
 * that is no longer produced.
 */
import type { TrustTier } from '@kici-dev/engine';

/** Result of ref-based trust resolution, with the reason recorded for audit. */
export interface TrustResolution {
  tier: TrustTier;
  contributorUsername: string;
  reason: string;
}

export function resolveRefTrust(args: {
  isForkPR: boolean;
  contributorUsername: string;
}): TrustResolution {
  if (args.isForkPR) {
    return {
      tier: 'unknown',
      contributorUsername: args.contributorUsername,
      reason: 'Fork PR — the head ref lives outside the base repo',
    };
  }
  return {
    tier: 'trusted',
    contributorUsername: args.contributorUsername,
    reason: 'Same-repo ref — pushed by a write-access contributor',
  };
}
