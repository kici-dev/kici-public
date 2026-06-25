import { $ } from 'zx';
import type { RuleContext, EventPayload, FanoutPosition } from '@kici-dev/sdk';
import { initZx } from '@kici-dev/shared';

// Initialize zx for cross-platform execution (module-level, runs once on import)
initZx();

/**
 * Create RuleContext for agent-side rule evaluation.
 *
 * @param event - Event payload from the dispatch message
 * @param changedFiles - List of files changed in this event
 * @param env - Merged environment variables
 * @param dispatchInputs - Operator dispatch inputs (`ctx.dispatchInputs`)
 * @param fanout - Fan-out position (`ctx.fanout`); undefined on a non-fan-out job
 */
export function createRuleContext(
  event: Record<string, unknown>,
  changedFiles: string[] = [],
  env: Record<string, string | undefined> = {},
  dispatchInputs: Readonly<Record<string, string | number | boolean | null>> = {},
  fanout?: FanoutPosition,
): RuleContext {
  return {
    event: event as EventPayload,
    changedFiles,
    env,
    dispatchInputs,
    ...(fanout && { fanout }),
    $,
  };
}

// Re-export evaluateRules and RuleEvaluationResult from SDK (single source of truth)
export { evaluateRules, type RuleEvaluationResult } from '@kici-dev/sdk';
