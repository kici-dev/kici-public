/**
 * Concurrency gate -- checks concurrency limits.
 */
import type { Environment, ProtectionGateResult } from '@kici-dev/engine';

/** Evaluate concurrency limits for the environment. */
export function evaluateConcurrencyGate(
  env: Environment,
  currentRunningCount: number,
  _concurrencyGroup: string,
): ProtectionGateResult {
  // No limit = unlimited
  if (env.concurrencyLimit === null) {
    return { action: 'pass' };
  }

  // Below limit = pass
  if (currentRunningCount < env.concurrencyLimit) {
    return { action: 'pass' };
  }

  // At or above limit
  if (env.concurrencyStrategy === 'cancel-pending') {
    return {
      action: 'queue',
      reason: 'cancel-pending',
      holdType: 'concurrency',
    };
  }

  return {
    action: 'queue',
    reason: `Concurrency limit reached (${currentRunningCount}/${env.concurrencyLimit})`,
    holdType: 'concurrency',
  };
}
