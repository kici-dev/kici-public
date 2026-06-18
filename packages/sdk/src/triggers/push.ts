/**
 * Push trigger helper - creates triggers for push events.
 * Returns a frozen PushTriggerConfig directly (no builder pattern).
 */

import {
  type BranchPattern,
  type PushConfigInput,
  type PushTriggerConfig,
  toBranchPattern,
  asArray,
} from './types.js';

/**
 * Create a push trigger configuration.
 * Returns a frozen (immutable) PushTriggerConfig object directly.
 *
 * @example
 * // No-arg: matches any push
 * push()
 *
 * // Config style
 * push({ branches: ['main', 'develop'], paths: ['src/**'] })
 *
 * // With tags
 * push({ tags: ['v*'] })
 *
 * // Full config
 * push({
 *   branches: 'main',
 *   tags: ['v*', /^release-\d+$/],
 *   paths: ['src/**', '!**\/*.test.ts'],
 *   description: 'Pushes to main or version tags',
 * })
 */
export function push(config?: PushConfigInput): PushTriggerConfig {
  const branches: BranchPattern[] = config?.branches
    ? asArray(config.branches).map(toBranchPattern)
    : [];

  const tags: BranchPattern[] = config?.tags ? asArray(config.tags).map(toBranchPattern) : [];

  const paths = config?.paths ?? [];

  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: PushTriggerConfig = {
    _tag: 'PushTrigger',
    branches: Object.freeze([...branches]),
    tags: Object.freeze([...tags]),
    paths: Object.freeze([...paths]),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
