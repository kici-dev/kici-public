/**
 * Comment trigger helper - creates triggers for issue/PR comment events.
 * Returns a frozen CommentTriggerConfig directly.
 */

import type {
  BodyMatchPattern,
  BranchPattern,
  CommentConfigInput,
  CommentTriggerConfig,
} from './types.js';
import { normalizeRegexFlags } from '@kici-dev/engine';
import { toBranchPattern, asArray } from './types.js';

/**
 * Convert a string or RegExp to a BodyMatchPattern.
 * Strings become glob patterns, RegExp becomes regex patterns.
 *
 * `g` and `y` are dropped for the same reason as `toBranchPattern`: the reader
 * memoizes the compiled instance, so a sticky one alternates verdicts between
 * comments.
 */
function toBodyMatchPattern(input: string | RegExp): BodyMatchPattern {
  if (input instanceof RegExp) {
    return {
      type: 'regex',
      pattern: input.source,
      flags: normalizeRegexFlags(input.flags),
    };
  }
  return {
    type: 'glob',
    pattern: input,
  };
}

/**
 * Create a comment trigger configuration.
 *
 * @example
 * // Match any comment
 * comment()
 *
 * // Match deploy commands
 * comment({ bodyMatch: '/deploy' })
 *
 * // Match with regex
 * comment({ bodyMatch: /^\/deploy/i, source: 'pr' })
 */
export function comment(config?: CommentConfigInput): CommentTriggerConfig {
  const repos: BranchPattern[] = config?.repos ? asArray(config.repos).map(toBranchPattern) : [];

  const result: CommentTriggerConfig = {
    _tag: 'CommentTrigger',
    actions: Object.freeze(config?.actions ? [...config.actions] : []),
    ...(config?.source !== undefined && { source: config.source }),
    ...(config?.bodyMatch !== undefined && { bodyMatch: toBodyMatchPattern(config.bodyMatch) }),
    repos: Object.freeze([...repos]),
    ...(config?.description !== undefined && { description: config.description }),
  };

  return Object.freeze(result);
}
