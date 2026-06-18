/**
 * PR trigger helper - creates triggers for pull request events.
 * Returns a frozen PrTriggerConfig directly (no builder pattern).
 */

import {
  type BranchPattern,
  type PrConfigInput,
  type PrTriggerConfig,
  DEFAULT_PR_EVENTS,
  toBranchPattern,
  asArray,
} from './types.js';

/**
 * Create a PR trigger configuration.
 * Returns a frozen (immutable) PrTriggerConfig object directly.
 *
 * @example
 * // No-arg: default events, no branch/path filters
 * pr()
 *
 * // Config style
 * pr({ target: 'main', paths: ['src/**'] })
 *
 * // Full config
 * pr({
 *   events: ['opened', 'synchronize'],
 *   target: ['main', /^release-\d+$/],
 *   source: 'feature/*',
 *   paths: ['src/**', '!**\/*.test.ts'],
 *   description: 'PRs targeting main with source changes',
 * })
 */
export function pr(config?: PrConfigInput): PrTriggerConfig {
  const events = config?.events ?? [...DEFAULT_PR_EVENTS];

  const targetBranches: BranchPattern[] = config?.target
    ? asArray(config.target).map(toBranchPattern)
    : [];

  const sourceBranches: BranchPattern[] = config?.source
    ? asArray(config.source).map(toBranchPattern)
    : [];

  const paths = config?.paths ?? [];

  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: PrTriggerConfig = {
    _tag: 'PrTrigger',
    events: Object.freeze([...events]),
    targetBranches: Object.freeze([...targetBranches]),
    sourceBranches: Object.freeze([...sourceBranches]),
    paths: Object.freeze([...paths]),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
