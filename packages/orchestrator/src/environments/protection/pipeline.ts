/**
 * Protection gate pipeline -- evaluates gates sequentially.
 *
 * Gates evaluated in order: branch -> trust -> concurrency -> reviewer -> timer.
 * First non-pass result stops evaluation.
 */
import type { Environment, ProtectionGateResult, TrustTier } from '@kici-dev/engine';
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
}

/** Evaluate all protection rules for an environment. */
export async function evaluateProtectionRules(
  env: Environment,
  ctx: JobDispatchContext,
  currentRunningCount: number,
  concurrencyGroup: string,
  trustTier?: TrustTier,
): Promise<ProtectionGateResult> {
  // Disabled environments always reject
  if (!env.enabled) {
    return {
      action: 'reject',
      reason: `Environment '${env.name}' is disabled`,
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
