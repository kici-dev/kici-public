/** Fork trigger helper for fork events. */

import type { BranchPattern, ForkConfigInput, ForkTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a frozen fork trigger configuration. No filter fields.
 *
 * @example
 * // Match any fork event
 * fork()
 *
 * // With description
 * fork({ description: 'Track repository forks' })
 */
export function fork(config?: ForkConfigInput): ForkTriggerConfig {
  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: ForkTriggerConfig = {
    _tag: 'ForkTrigger',
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
