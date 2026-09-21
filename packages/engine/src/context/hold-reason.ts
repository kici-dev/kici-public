/**
 * Protection-gate hold-reason template — the free-text sentence the trust gate
 * persists into `held_runs.reason` when a contributor is below a context's
 * `minimumTrust`.
 *
 * Single source of truth for the sentence: the orchestrator's trust gate emits
 * it, the ci-security DB fixture seeds it, and the unit and E2E assertions
 * compare against it. One copy means a copy edit moves every site at once
 * (`.claude/rules/code-style.md` § "Enums over hardcoded strings").
 *
 * `held_runs.reason` is a free-text column, so this is a function rather than
 * an enum: the sentence carries the context name, which is per-hold data.
 *
 * Carries no runtime import on purpose — this module reaches the browser
 * through the engine barrel, which must pull in no Node built-ins
 * (`.claude/rules/engine.md` § "Browser-safe barrel export"). The one import
 * below is type-only and is erased at compile time.
 */
import type { TrustTier } from './types.js';

/**
 * Reason a run is held because the context requires `minimumTrust: 'trusted'`
 * and the contributor's tier is below that. `trustTier` is the contributor's
 * actual tier, which the gate has already narrowed to a tier below `trusted` —
 * so the type excludes `'trusted'`, whose sentence would read as a
 * contradiction.
 */
export function trustedContributorHoldReason(
  contextName: string,
  trustTier: Exclude<TrustTier, 'trusted'>,
): string {
  return `Context '${contextName}' requires trusted contributors (contributor is ${trustTier})`;
}
