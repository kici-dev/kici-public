/**
 * Protection-gate hold-reason template — the sentence the trust gate persists
 * into `held_runs.reason` when a contributor is below a context's
 * `minimumTrust`. The orchestrator's trust gate and the test assertions share
 * this one copy.
 *
 * A function rather than an enum: the sentence carries the context name, which
 * is per-hold data.
 *
 * No runtime import on purpose: this module reaches the browser through the
 * engine barrel, which must pull in no Node built-ins.
 */
import type { TrustTier } from './types.js';

/**
 * Reason a run is held because the context requires `minimumTrust: 'trusted'`
 * and the contributor's tier is below that. The type excludes `'trusted'`,
 * whose sentence would read as a contradiction.
 */
export function trustedContributorHoldReason(
  contextName: string,
  trustTier: Exclude<TrustTier, 'trusted'>,
): string {
  return `Context '${contextName}' requires trusted contributors (contributor is ${trustTier})`;
}
