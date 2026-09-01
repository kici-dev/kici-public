/**
 * Protection gate pipeline -- evaluates gates sequentially.
 *
 * Gates evaluated in order: branch -> trust -> concurrency -> reviewer -> timer.
 * First non-pass result stops evaluation.
 */
import type { Context, ProtectionGateResult, TrustTier } from '@kici-dev/engine';
import { evaluateBranchGate } from './branch-gate.js';
import { evaluateConcurrencyGate } from './concurrency-gate.js';
import { evaluateReviewerGate } from './reviewer-gate.js';
import { evaluateTrustGate } from './trust-gate.js';
import { evaluateWaitTimerGate } from './wait-timer-gate.js';

/** Context needed for protection gate evaluation. */
export interface JobDispatchContext {
  branch: string;
  triggerType: string;
  repository: string;
  runId: string;
  jobId: string;
  /**
   * True when the run was triggered by the orchestrator itself (a schedule
   * fire, a workflow/job completion, a failure batch, a `kiciEvent()`, an
   * invoke-gate summon) rather than by a provider webhook.
   *
   * Such a run usually DOES carry a branch, and `branch` is then matched
   * against the restriction patterns like any other run's: a schedule fire
   * presents its registration's default branch, and every other internal
   * trigger inherits the branch of the run that emitted its event.
   *
   * The flag matters only when `branch` is EMPTY — a failure batch or a scaler
   * event (many runs behind it, or none), a registration whose default branch
   * has never been captured, an emitting run that is gone. The branch gate then
   * rejects naming that cause, instead of quoting the empty value as a branch
   * name an operator could add to the restriction list. It never weakens the
   * gate: a run with no branch cannot satisfy a restriction, `*` included.
   */
  internallyTriggered?: boolean;
}

/** Evaluate all protection rules for a context. */
export async function evaluateProtectionRules(
  env: Context,
  ctx: JobDispatchContext,
  currentRunningCount: number,
  concurrencyGroup: string,
  trustTier?: TrustTier,
): Promise<ProtectionGateResult> {
  // Disabled contexts always reject
  if (!env.enabled) {
    return {
      action: 'reject',
      reason: `Context '${env.name}' is disabled`,
    };
  }

  // Evaluate gates in order: branch -> trust -> concurrency -> reviewer -> timer
  const gates: ProtectionGateResult[] = [
    evaluateBranchGate(env, ctx),
    evaluateTrustGate(env, trustTier),
    evaluateConcurrencyGate(env, currentRunningCount, concurrencyGroup),
    evaluateReviewerGate(env),
    evaluateWaitTimerGate(env),
  ];

  for (const result of gates) {
    if (result.action !== 'pass') {
      return result;
    }
  }

  return { action: 'pass' };
}
