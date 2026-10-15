import type { Rule, RuleContext, RuleResult } from './types.js';
import { toErrorMessage } from '@kici-dev/core';
import { ChangedFilesUnavailableError } from './context.js';

export interface RuleEvaluationResult {
  allPassed: boolean;
  results: RuleResult[];
  /**
   * Set iff a rule's check() threw, never for a clean `return false`.
   * Consumers fail the job or step on it: a crashed gate read as a silent skip
   * would be a false green.
   */
  evaluationError?: { label: string; message: string };
}

/**
 * Evaluate rules in order, timing each, and stop at the first failure.
 * `ChangedFilesUnavailableError` is rethrown, never read as a failed rule.
 *
 * @param _label - Reserved for callers (e.g. the job name); unused here.
 * @param onRuleResult - Called after each evaluated rule.
 */
export async function evaluateRules(
  rules: Rule[],
  context: RuleContext,
  _label: string,
  onRuleResult?: (result: RuleResult) => void,
): Promise<RuleEvaluationResult> {
  const results: RuleResult[] = [];
  let allPassed = true;
  let evaluationError: { label: string; message: string } | undefined;

  for (const rule of rules) {
    const startTime = Date.now();
    let passed = false;
    let error: string | undefined;

    try {
      passed = await rule.check(context);
    } catch (e) {
      if (e instanceof ChangedFilesUnavailableError) throw e; // fatal — never a silent skip
      passed = false;
      error = toErrorMessage(e);
      evaluationError = { label: rule.label, message: error };
    }

    const durationMs = Date.now() - startTime;

    const result: RuleResult = {
      label: rule.label,
      passed,
      durationMs,
      error,
    };

    results.push(result);
    onRuleResult?.(result);

    if (!passed) {
      allPassed = false;
      break;
    }
  }

  return { allPassed, results, evaluationError };
}
