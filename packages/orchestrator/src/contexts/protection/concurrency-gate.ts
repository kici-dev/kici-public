/**
 * Concurrency gate -- checks concurrency limits.
 */
import { ConcurrencyStrategy, HoldType } from '@kici-dev/engine';
import type { Context, ProtectionGateResult } from '@kici-dev/engine';

/**
 * Evaluate concurrency limits for the context.
 *
 * Takes only the two fields it reads rather than a whole `Context`, so the
 * ready-dispatch re-gate can call it with the limit and strategy it resolved
 * from a run's bound context row. Every full `Context` still satisfies it.
 */
export function evaluateConcurrencyGate(
  env: Pick<Context, 'concurrencyLimit' | 'concurrencyStrategy'>,
  currentRunningCount: number,
  _concurrencyGroup: string,
): ProtectionGateResult {
  // No limit (null), or a degenerate non-positive limit, = unlimited.
  // A concurrencyLimit of 0 is rejected at the write boundary, but any legacy
  // or edge value that reaches the gate must never create an unreleasable
  // workflow-install concurrency hold.
  if (env.concurrencyLimit === null || env.concurrencyLimit <= 0) {
    return { action: 'pass' };
  }

  // Below limit = pass
  if (currentRunningCount < env.concurrencyLimit) {
    return { action: 'pass' };
  }

  // At or above limit
  if (env.concurrencyStrategy === ConcurrencyStrategy.enum['cancel-pending']) {
    return {
      // `action` here is the gate vocabulary (`'hold' | 'wait' | 'queue'`), a
      // different enum that merely shares the `queue` spelling — not the
      // concurrency strategy. The `reason` is the free-form detail string the
      // dispatcher surfaces, which happens to name the strategy that produced it.
      action: 'queue',
      reason: 'cancel-pending',
      holdType: HoldType.enum.concurrency,
    };
  }

  return {
    action: 'queue',
    reason: `Concurrency limit reached (${currentRunningCount}/${env.concurrencyLimit})`,
    holdType: HoldType.enum.concurrency,
  };
}
