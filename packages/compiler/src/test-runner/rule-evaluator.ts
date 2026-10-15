import type { Rule, RuleContext, CreateRuleContextInput } from '@kici-dev/sdk';
import {
  createRuleContext as createSdkRuleContext,
  evaluateRules as evaluateRulesCore,
} from '@kici-dev/sdk/internal';
import type { RuleEvaluationResult } from '@kici-dev/sdk';
import { initZx } from '@kici-dev/core';
import { formatter } from './output-formatter.js';

initZx();

/**
 * Defaults `env` to the developer's real process env, and `changedFilesStatus`
 * to `'fetched'` so an author-supplied (or empty) test changeset is a genuine
 * diff and `ctx.changedFiles` never throws.
 */
export function createRuleContext(input: CreateRuleContextInput): RuleContext {
  return createSdkRuleContext({
    ...input,
    env: input.env ?? ({ ...process.env } as Record<string, string | undefined>),
    changedFilesStatus: input.changedFilesStatus ?? 'fetched',
  });
}

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
