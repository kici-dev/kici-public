/**
 * Trust gate -- a context that sets any `minimumTrust` holds a run whose ref
 * resolved as a fork.
 *
 * Trust is ref-based (`security/trust-resolver.ts`): a ref that lives in the
 * base repo resolves `'trusted'`, a ref that comes from a fork resolves
 * `'unknown'`. So for a resolved tier the gate asks one question -- is it
 * `'unknown'`? -- and it asks that same question for every non-null
 * `minimumTrust`, rather than ranking the declared floor against the tier. A
 * run that carries no resolved tier is handled separately, below.
 *
 * `'known'` is legacy vocabulary that `resolveRefTrust` no longer produces. A
 * context may still declare it as its floor, and an internally-triggered run
 * may still inherit it from a stored `execution_runs.trust_tier` row
 * (`inheritRunResolution` parses that column back into a tier). Neither changes
 * the verdict.
 *
 * The declared floor is not discarded: it selects which hold reason the gate
 * emits, so the sentence written into `held_runs.reason` names the bar the
 * operator declared, for the two floors the type admits.
 */
import {
  HoldType,
  trustedContributorHoldReason,
  unknownContributorHoldReason,
} from '@kici-dev/engine';
import type { Context, ProtectionGateResult, TrustTier } from '@kici-dev/engine';

/** Evaluate minimumTrust requirements for the context. */
export function evaluateTrustGate(
  env: Context,
  trustTier: TrustTier | undefined,
): ProtectionGateResult {
  // If context has no minimumTrust, pass
  if (!env.minimumTrust) {
    return { action: 'pass' };
  }

  // An unresolved tier passes. Several dispatch paths reach here with one, and
  // the set is open — among them an internally-triggered run whose inheritance
  // lookup degraded, a pull-request event on a provider with no fork model, a
  // cross-source dispatch, and a `kici run` remote test run. This is the
  // lenient reading `isUntrustedTier` also takes; `deriveCacheRefScope` reads
  // the same `undefined` strictly.
  if (!trustTier) {
    return { action: 'pass' };
  }

  if (trustTier === 'unknown') {
    return {
      action: 'hold',
      reason:
        env.minimumTrust === 'trusted'
          ? trustedContributorHoldReason(env.name, trustTier)
          : unknownContributorHoldReason(env.name),
      holdType: HoldType.enum.security,
    };
  }

  return { action: 'pass' };
}
