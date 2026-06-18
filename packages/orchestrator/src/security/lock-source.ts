/**
 * Lock-file branch selection for webhook processing.
 *
 * For pull-request events, the orchestrator must decide whether to fetch
 * the workflow lock file from the PR head branch (the contributor's
 * proposed change) or from the base branch (the protected target). Only
 * trusted contributors get their HEAD lock evaluated; everyone else
 * (unknown / known / undefined trust resolution) falls back to the base
 * branch's lock so an untrusted contributor cannot inject triggers,
 * jobs, or environment claims that the project's maintainers haven't
 * vetted.
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
 * untrusted contributor (`tier === 'unknown' | 'known' | undefined`)
 * MUST NOT have their HEAD lock file evaluated by the orchestrator.
 * The base-branch lock — controlled by the project's trusted
 * maintainers — is the source of truth for trigger evaluation,
 * trust-tier-based environment access, and contributor-controlled
 * fields that downstream secret resolution depends on.
 *
 * Only `tier === 'trusted'` (an identity-linked contributor with
 * provider write+ permission AND ci_trust write+ permission, per
 * `TrustResolver.resolveTrustTier`) can have their HEAD lock evaluated.
 */
export function selectLockFileSource(
  isPREvent: boolean,
  tier: TrustTier | undefined,
): 'head' | 'base' {
  if (!isPREvent) return 'head';
  return tier === 'trusted' ? 'head' : 'base';
}
