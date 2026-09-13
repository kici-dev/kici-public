/**
 * Create trigger helper - creates triggers for ref creation events (branches/tags).
 * Returns a frozen CreateTriggerConfig directly.
 */

import type { BranchPattern, CreateConfigInput, CreateTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a ref creation trigger configuration.
 *
 * @example
 * // Match any ref creation
 * create()
 *
 * // Match tag creation with patterns
 * create({ refTypes: ['tag'], patterns: ['v*'] })
 *
 * // Match branch creation
 * create({ refTypes: ['branch'], patterns: ['release/*'] })
 */
export function create(config?: CreateConfigInput): CreateTriggerConfig {
  const patterns: BranchPattern[] = config?.patterns
    ? asArray(config.patterns).map(toBranchPattern)
    : [];

  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: CreateTriggerConfig = {
    _tag: 'CreateTrigger',
    refTypes: Object.freeze(config?.refTypes ? [...config.refTypes] : []),
    patterns: Object.freeze([...patterns]),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
