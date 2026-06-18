/**
 * Tag trigger helper - creates triggers for tag push events.
 * Returns a frozen TagTriggerConfig directly.
 */

import type { BranchPattern, TagConfigInput, TagTriggerConfig } from './types.js';
import { toBranchPattern, asArray } from './types.js';

/**
 * Create a tag trigger configuration.
 *
 * @example
 * // Match any tag
 * tag()
 *
 * // Match specific patterns
 * tag({ patterns: ['v*'] })
 *
 * // With regex
 * tag({ patterns: [/^v\d+\.\d+\.\d+$/] })
 */
export function tag(config?: TagConfigInput): TagTriggerConfig {
  const patterns: BranchPattern[] = config?.patterns
    ? asArray(config.patterns).map(toBranchPattern)
    : [];

  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: TagTriggerConfig = {
    _tag: 'TagTrigger',
    patterns: Object.freeze([...patterns]),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
