import type { BranchPattern, WatchConfigInput, WatchTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a watch trigger. Returns a frozen WatchTriggerConfig.
 *
 * @example
 * // Match any watch event
 * watch()
 *
 * // Match specific actions
 * watch({ actions: ['started'] })
 */
export function watch(config?: WatchConfigInput): WatchTriggerConfig {
  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: WatchTriggerConfig = {
    _tag: 'WatchTrigger',
    actions: Object.freeze(config?.actions ? [...config.actions] : []),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
