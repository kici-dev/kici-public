/**
 * Lock-file branch selection for webhook processing.
 *
 * For pull-request events, the orchestrator must decide whether to fetch
 * the workflow lock file from the PR head branch (the contributor's
 * proposed change) or from the base branch (the protected target). Only
 * a trusted ref gets its HEAD lock evaluated; everything else
 * (unknown / known / undefined trust resolution) falls back to the base
 * branch's lock so a fork ref cannot inject triggers, jobs, or
 * environment claims that the project's maintainers haven't vetted.
 *
 * The default for non-PR events is HEAD, because there is no untrusted
 * "incoming" contribution to gate against — push events come directly
 * from someone with write access.
 */

import type { TrustTier } from '@kici-dev/engine';

/**
 * Select which branch's lock file to fetch.
 *
 * Invariant (customer-isolation): for any pull-request event, an
 * untrusted ref (`tier === 'unknown' | 'known' | undefined`) MUST NOT
 * have its HEAD lock file evaluated by the orchestrator. The
 * base-branch lock — controlled by the project's trusted maintainers —
 * is the source of truth for trigger evaluation, trust-tier-based
 * environment access, and contributor-controlled fields that downstream
 * secret resolution depends on.
 *
 * Only `tier === 'trusted'` (a ref that lives in the base repo, per
 * `resolveRefTrust`) can have its HEAD lock evaluated.
 */
export function selectLockFileSource(
  isPREvent: boolean,
  tier: TrustTier | undefined,
): 'head' | 'base' {
  if (!isPREvent) return 'head';
  return tier === 'trusted' ? 'head' : 'base';
}
