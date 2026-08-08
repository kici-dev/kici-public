import type { Rule, RuleContext, CreateRuleContextInput } from '@kici-dev/sdk';
import {
  createRuleContext as createSdkRuleContext,
  evaluateRules as evaluateRulesCore,
} from '@kici-dev/sdk';
import type { RuleEvaluationResult } from '@kici-dev/sdk';
import { initZx } from '@kici-dev/core';
import { formatter } from './output-formatter.js';

// Initialize zx for cross-platform execution (module-level, runs once on import)
initZx();

/**
 * Create a RuleContext for `kici test` rule evaluation. Delegates to the shared
 * SDK factory (single source of truth), defaulting `env` to the process
 * environment — the test-runner exposes the developer's real env to rules — and
 * `changedFilesStatus` to `'fetched'` so an author-supplied (or empty) test
 * changeset is a genuine diff and `ctx.changedFiles` never throws.
 */
export function createRuleContext(input: CreateRuleContextInput): RuleContext {
  return createSdkRuleContext({
    ...input,
    env: input.env ?? ({ ...process.env } as Record<string, string | undefined>),
    changedFilesStatus: input.changedFilesStatus ?? 'fetched',
  });
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
    formatter.logRuleResult(jobName, result);
  });
}

export { evaluateRulesWithFormatting as evaluateRules };
export type { RuleEvaluationResult };
