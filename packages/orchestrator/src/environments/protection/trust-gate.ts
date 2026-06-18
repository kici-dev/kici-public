/**
 * Trust gate -- checks contributor trust tier against environment minimumTrust.
 */
import type { Environment, ProtectionGateResult, TrustTier } from '@kici-dev/engine';

/** Evaluate minimumTrust requirements for the environment. */
export function evaluateTrustGate(
  env: Environment,
  trustTier: TrustTier | undefined,
): ProtectionGateResult {
  // If environment has no minimumTrust, pass
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
      reason: `Environment '${env.name}' requires trusted contributors (contributor is ${trustTier})`,
      holdType: 'security',
    };
  }

  if (required === 'known' && trustTier === 'unknown') {
    return {
      action: 'hold',
      reason: `Environment '${env.name}' requires known contributors (contributor is unknown)`,
      holdType: 'security',
    };
  }

  return { action: 'pass' };
}
