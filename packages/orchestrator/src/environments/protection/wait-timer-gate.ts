/**
 * Wait timer gate -- checks wait timer configuration.
 */
import type { Environment, ProtectionGateResult } from '@kici-dev/engine';

/** Evaluate wait timer for the environment. */
export function evaluateWaitTimerGate(env: Environment): ProtectionGateResult {
  if (env.waitTimerSeconds === null) {
    return { action: 'pass' };
  }

  const holdUntil = new Date(Date.now() + env.waitTimerSeconds * 1000).toISOString();

  return {
    action: 'wait',
    holdType: 'timer',
    holdUntil,
    reason: `Wait timer: ${env.waitTimerSeconds}s`,
  };
}
