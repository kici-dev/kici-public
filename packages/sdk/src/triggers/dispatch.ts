/**
 * Dispatch trigger helper - creates triggers for repository_dispatch events.
 * Returns a frozen DispatchTriggerConfig directly.
 */

import type { BranchPattern, DispatchConfigInput, DispatchTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a repository dispatch trigger configuration.
 *
 * @example
 * // Match any dispatch event
 * dispatch()
 *
 * // Match specific event types
 * dispatch({ types: ['deploy', 'rollback'] })
 */
export function dispatch(config?: DispatchConfigInput): DispatchTriggerConfig {
  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: DispatchTriggerConfig = {
    _tag: 'DispatchTrigger',
    types: Object.freeze(config?.types ? [...config.types] : []),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
