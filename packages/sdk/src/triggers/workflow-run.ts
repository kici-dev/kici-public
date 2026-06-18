/**
 * Workflow run trigger helper - creates triggers for workflow_run events.
 * Returns a frozen WorkflowRunTriggerConfig directly.
 */

import type { BranchPattern, WorkflowRunConfigInput, WorkflowRunTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a workflow run trigger configuration.
 *
 * @example
 * // Match any workflow run event
 * workflowRun()
 *
 * // Match specific workflows and conclusions
 * workflowRun({ workflows: ['CI'], actions: ['completed'], conclusions: ['success'] })
 */
export function workflowRun(config?: WorkflowRunConfigInput): WorkflowRunTriggerConfig {
  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: WorkflowRunTriggerConfig = {
    _tag: 'WorkflowRunTrigger',
    actions: Object.freeze(config?.actions ? [...config.actions] : []),
    workflows: Object.freeze(config?.workflows ? [...config.workflows] : []),
    conclusions: Object.freeze(config?.conclusions ? [...config.conclusions] : []),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
