import type { BranchPattern, StarConfigInput, StarTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a frozen star trigger configuration.
 *
 * @example
 * // Match any star event
 * star()
 *
 * // Match specific actions
 * star({ actions: ['created'] })
 */
export function star(config?: StarConfigInput): StarTriggerConfig {
  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: StarTriggerConfig = {
    _tag: 'StarTrigger',
    actions: Object.freeze(config?.actions ? [...config.actions] : []),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
