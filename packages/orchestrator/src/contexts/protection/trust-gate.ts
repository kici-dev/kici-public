/**
 * Trust gate -- a context that sets `minimumTrust` holds a run whose ref
 * resolved as a fork.
 *
 * Trust is ref-based (`security/trust-resolver.ts`): a ref that lives in the
 * base repo resolves `'trusted'`, a ref that comes from a fork resolves
 * `'unknown'`. So for a resolved tier the gate asks one question -- is it
 * `'unknown'`? A run that carries no resolved tier is handled separately, below.
 */
import { HoldType, trustedContributorHoldReason } from '@kici-dev/engine';
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
      reason: trustedContributorHoldReason(env.name, trustTier),
      holdType: HoldType.enum.security,
    };
  }

  return { action: 'pass' };
}
