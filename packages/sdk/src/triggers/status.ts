/**
 * Status trigger helper - creates triggers for commit status events.
 * Returns a frozen StatusTriggerConfig directly.
 */

import type { BranchPattern, StatusConfigInput, StatusTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a commit status trigger configuration.
 *
 * @example
 * // Match any status event
 * status()
 *
 * // Match specific contexts and states
 * status({ contexts: ['ci/*'], states: ['success'] })
 */
export function status(config?: StatusConfigInput): StatusTriggerConfig {
  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: StatusTriggerConfig = {
    _tag: 'StatusTrigger',
    contexts: Object.freeze(config?.contexts ? [...config.contexts] : []),
    states: Object.freeze(config?.states ? [...config.states] : []),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
