/**
 * Release trigger helper - creates triggers for release events.
 * Returns a frozen ReleaseTriggerConfig directly.
 */

import type { BranchPattern, ReleaseConfigInput, ReleaseTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a release trigger configuration.
 *
 * @example
 * // Match any release event
 * release()
 *
 * // Match specific actions
 * release({ actions: ['published'] })
 */
export function release(config?: ReleaseConfigInput): ReleaseTriggerConfig {
  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: ReleaseTriggerConfig = {
    _tag: 'ReleaseTrigger',
    actions: Object.freeze(config?.actions ? [...config.actions] : []),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
