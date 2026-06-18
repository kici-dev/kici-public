/**
 * Delete trigger helper - creates triggers for ref deletion events (branches/tags).
 * Returns a frozen DeleteTriggerConfig directly.
 *
 * Note: `delete` is a reserved word in JavaScript, so the internal function
 * is named `del` and re-exported as `delete` from index.ts.
 */

import type { BranchPattern, DeleteConfigInput, DeleteTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a ref deletion trigger configuration.
 *
 * @example
 * // Match any ref deletion
 * del()
 *
 * // Match tag deletion
 * del({ refTypes: ['tag'], patterns: ['v*'] })
 */
export function del(config?: DeleteConfigInput): DeleteTriggerConfig {
  const patterns: BranchPattern[] = config?.patterns
    ? asArray(config.patterns).map(toBranchPattern)
    : [];

  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: DeleteTriggerConfig = {
    _tag: 'DeleteTrigger',
    refTypes: Object.freeze(config?.refTypes ? [...config.refTypes] : []),
    patterns: Object.freeze([...patterns]),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
