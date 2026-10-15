import { initZx } from '@kici-dev/shared';

// Module-level: runs once, on import.
initZx();

// The rule context factory and evaluator live in the SDK.
export { ChangedFilesUnavailableError, type RuleEvaluationResult } from '@kici-dev/sdk';
export { createRuleContext, evaluateRules } from '@kici-dev/sdk/internal';
