/**
 * Trust gate -- checks contributor trust tier against context minimumTrust.
 */
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
      reason: `Context '${env.name}' requires trusted contributors (contributor is ${trustTier})`,
      holdType: 'security',
    };
  }

  if (required === 'known' && trustTier === 'unknown') {
    return {
      action: 'hold',
      reason: `Context '${env.name}' requires known contributors (contributor is unknown)`,
      holdType: 'security',
    };
  }

  return { action: 'pass' };
}
