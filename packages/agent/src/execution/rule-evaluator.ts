import { initZx } from '@kici-dev/shared';

// Initialize zx for cross-platform execution (module-level, runs once on import)
initZx();

// Single source of truth: the rule context factory + evaluator live in the SDK.
export {
  createRuleContext,
  ChangedFilesUnavailableError,
  evaluateRules,
  type RuleEvaluationResult,
} from '@kici-dev/sdk';
