import type { Rule, RuleContext, RuleResult } from './types.js';
import { toErrorMessage } from '@kici-dev/core';
import { ChangedFilesUnavailableError } from './context.js';

/**
 * Result of evaluating rules for a job or workflow.
 * Contains overall pass/fail status and per-rule results.
 */
export interface RuleEvaluationResult {
  allPassed: boolean;
  results: RuleResult[];
  /**
   * Set iff a rule's check() threw — an evaluation failure, NOT a clean
   * `return false`. Consumers fail-hard on this (surface the error + fail the
   * job/step) instead of treating a crashed gate as a silent skip, which would
   * be a false green. A clean false leaves this undefined.
   */
  evaluationError?: { label: string; message: string };
}

/**
 * Evaluate rules sequentially with fail-fast behavior.
 *
 * Iterates rules in order, calling each rule's check function with the provided
 * context. Records timing and result for each evaluated rule. Stops evaluation
 * on the first failure (remaining rules are not evaluated).
 *
 * @param rules - Array of Rule objects to evaluate
 * @param context - RuleContext providing event, env, changedFiles, and $
 * @param _label - Human-readable label for logging (e.g., job name) -- reserved for callers
 * @param onRuleResult - Optional callback invoked after each rule evaluation
 * @returns RuleEvaluationResult with allPassed flag and per-rule results
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
      // Fail fast - stop evaluating remaining rules
      break;
    }
  }

  return { allPassed, results, evaluationError };
}
