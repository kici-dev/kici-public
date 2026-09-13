/**
 * Workflows-failed-batch trigger helper.
 *
 * Accumulates failed workflow completions over a time window and fires the
 * subscribing global workflow once per window with the batched run list, so a
 * mass incident notifies a single time instead of once per failed run.
 */

import type {
  WorkflowsFailedBatchConfigInput,
  WorkflowsFailedBatchTriggerConfig,
} from './types.js';

/**
 * Create a workflows-failed-batch trigger configuration.
 *
 * @example
 * // Notify once for every burst of failures within a 10s window
 * workflowsFailedBatch({ accumulateFor: 10000 })
 *
 * // Scope the batch to a named workflow and a specific source repo
 * workflowsFailedBatch({ accumulateFor: 10000, name: 'CI', source: 'org/repo' })
 */
export function workflowsFailedBatch(
  config: WorkflowsFailedBatchConfigInput,
): WorkflowsFailedBatchTriggerConfig {
  return Object.freeze({
    _tag: 'WorkflowsFailedBatchTrigger',
    accumulateFor: config.accumulateFor,
    ...(config.name !== undefined && { name: config.name }),
    ...(config.source !== undefined && { source: config.source }),
    ...(config.description !== undefined && { description: config.description }),
  });
}
