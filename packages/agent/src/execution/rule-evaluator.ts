import { $ } from 'zx';
import type { RuleContext, EventPayload } from '@kici-dev/sdk';
import { initZx } from '@kici-dev/shared';

// Initialize zx for cross-platform execution (module-level, runs once on import)
initZx();

/**
 * Create RuleContext for agent-side rule evaluation.
 *
 * @param event - Event payload from the dispatch message
 * @param changedFiles - List of files changed in this event
 * @param env - Merged environment variables
 */
export function createRuleContext(
  event: Record<string, unknown>,
  changedFiles: string[] = [],
  env: Record<string, string | undefined> = {},
): RuleContext {
  return {
    event: event as EventPayload,
    changedFiles,
    env,
    $,
  };
}

// Re-export evaluateRules and RuleEvaluationResult from SDK (single source of truth)
export { evaluateRules, type RuleEvaluationResult } from '@kici-dev/sdk';
