import { $ } from 'zx';
import type { Rule, RuleContext, EventPayload } from '@kici-dev/sdk';
import { evaluateRules as evaluateRulesCore } from '@kici-dev/sdk';
import type { RuleEvaluationResult } from '@kici-dev/sdk';
import { initZx } from '@kici-dev/core';
import { formatter } from './output-formatter.js';

// Initialize zx for cross-platform execution (module-level, runs once on import)
initZx();

/**
 * Create RuleContext for rule evaluation.
 */
export function createRuleContext(
  event: EventPayload,
  changedFiles: string[] = [],
  dispatchInputs: Readonly<Record<string, string | number | boolean | null>> = {},
): RuleContext {
  return {
    event,
    changedFiles,
    env: { ...process.env } as Record<string, string | undefined>,
    dispatchInputs,
    $,
  };
}

/**
 * Evaluate rules with formatting output.
 * Wraps the SDK's evaluateRules() with a callback that logs each rule result.
 */
async function evaluateRulesWithFormatting(
  rules: Rule[],
  context: RuleContext,
  jobName: string,
): Promise<RuleEvaluationResult> {
  return evaluateRulesCore(rules, context, jobName, (result) => {
    formatter.logRuleResult(jobName, result.label, result.passed);
  });
}

export { evaluateRulesWithFormatting as evaluateRules };
export type { RuleEvaluationResult };
