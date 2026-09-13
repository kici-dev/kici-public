/**
 * Review trigger helper - creates triggers for pull request review events.
 * Returns a frozen ReviewTriggerConfig directly.
 */

import type { BranchPattern, ReviewConfigInput, ReviewTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a pull request review trigger configuration.
 *
 * @example
 * // Match any review event
 * review()
 *
 * // Match specific actions and states
 * review({ actions: ['submitted'], states: ['approved'] })
 */
export function review(config?: ReviewConfigInput): ReviewTriggerConfig {
  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: ReviewTriggerConfig = {
    _tag: 'ReviewTrigger',
    actions: Object.freeze(config?.actions ? [...config.actions] : []),
    states: Object.freeze(config?.states ? [...config.states] : []),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
