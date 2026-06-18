/**
 * Reviewer gate -- checks required reviewers.
 */
import type { Environment, ProtectionGateResult } from '@kici-dev/engine';

/** Evaluate reviewer requirements for the environment. */
export function evaluateReviewerGate(env: Environment): ProtectionGateResult {
  if (!env.requiredReviewers || env.requiredReviewers.length === 0) {
    return { action: 'pass' };
  }

  const holdUntil = new Date(Date.now() + env.holdExpirySeconds * 1000).toISOString();

  // Each required reviewer maps to a `{ user }` clause. Team-named reviewers
  // are a documented follow-up — for now every reviewer string is a user id.
  const clauses = env.requiredReviewers.map((reviewer) => ({ user: reviewer }));

  return {
    action: 'hold',
    holdType: 'reviewer',
    holdUntil,
    reason: `Requires approval from: ${env.requiredReviewers.join(', ')}`,
    clauses,
  };
}
