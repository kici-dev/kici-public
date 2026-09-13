/**
 * Wait timer gate -- checks wait timer configuration.
 */
import { HoldType } from '@kici-dev/engine';
import type { Context, ProtectionGateResult } from '@kici-dev/engine';

/** Evaluate wait timer for the context. */
export function evaluateWaitTimerGate(env: Context): ProtectionGateResult {
  if (env.waitTimerSeconds === null) {
    return { action: 'pass' };
  }

  const holdUntil = new Date(Date.now() + env.waitTimerSeconds * 1000).toISOString();

  return {
    action: 'wait',
    holdType: HoldType.enum.timer,
    holdUntil,
    reason: `Wait timer: ${env.waitTimerSeconds}s`,
  };
}
