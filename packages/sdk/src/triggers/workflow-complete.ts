/**
 * Workflow complete trigger helper - creates triggers for workflow completion events.
 * Returns a frozen WorkflowCompleteTriggerConfig directly.
 */

import type { WorkflowCompleteConfigInput, WorkflowCompleteTriggerConfig } from './types.js';

/**
 * Create a workflow completion trigger configuration.
 *
 * @example
 * // Match any workflow completion
 * workflowComplete()
 *
 * // Match specific workflow by name
 * workflowComplete({ name: 'CI' })
 *
 * // Match successful completions only
 * workflowComplete({ name: 'CI', status: ['success'] })
 *
 * // Cross-repo source filter
 * workflowComplete({ name: 'CI', status: ['success'], source: 'org/repo' })
 */
export function workflowComplete(
  config?: WorkflowCompleteConfigInput,
): WorkflowCompleteTriggerConfig {
  const result: WorkflowCompleteTriggerConfig = {
    _tag: 'WorkflowCompleteTrigger',
    ...(config?.name !== undefined && { name: config.name }),
    ...(config?.status !== undefined && {
      status: Object.freeze([...config.status]),
    }),
    ...(config?.source !== undefined && { source: config.source }),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
