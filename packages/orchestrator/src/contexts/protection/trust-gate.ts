/**
 * Trust gate -- checks contributor trust tier against context minimumTrust.
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

  // If trustTier is undefined (non-PR event like push), pass
  if (!trustTier) {
    return { action: 'pass' };
  }

  const required = env.minimumTrust;

  if (required === 'trusted' && trustTier !== 'trusted') {
    return {
      action: 'hold',
      reason: trustedContributorHoldReason(env.name, trustTier),
      holdType: HoldType.enum.security,
    };
  }

  if (required === 'known' && trustTier === 'unknown') {
    return {
      action: 'hold',
      reason: unknownContributorHoldReason(env.name),
      holdType: HoldType.enum.security,
    };
  }

  return { action: 'pass' };
}
