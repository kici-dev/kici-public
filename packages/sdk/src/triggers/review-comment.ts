/**
 * Review comment trigger helper - creates triggers for PR review comment events.
 * Returns a frozen ReviewCommentTriggerConfig directly.
 */

import type {
  BranchPattern,
  ReviewCommentConfigInput,
  ReviewCommentTriggerConfig,
} from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a pull request review comment trigger configuration.
 *
 * @example
 * // Match any review comment event
 * reviewComment()
 *
 * // Match specific actions
 * reviewComment({ actions: ['created', 'edited'] })
 */
export function reviewComment(config?: ReviewCommentConfigInput): ReviewCommentTriggerConfig {
  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: ReviewCommentTriggerConfig = {
    _tag: 'ReviewCommentTrigger',
    actions: Object.freeze(config?.actions ? [...config.actions] : []),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
