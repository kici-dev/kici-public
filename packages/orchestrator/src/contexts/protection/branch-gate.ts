/**
 * Branch gate -- checks branch restrictions, trigger type filters, and repo patterns.
 */
import picomatch from 'picomatch';
import type { Context, ProtectionGateResult } from '@kici-dev/engine';
import type { JobDispatchContext } from './pipeline.js';

/**
 * The reason phrase for a branch-restricted context bound by an
 * internally-triggered run that carries NO branch. Shared with the multi-context
 * aggregator so the two reject paths cannot describe the same cause
 * differently, and context-free because each caller names the context itself.
 *
 * An internally-triggered run usually does have a branch: a scheduled run
 * presents its registration's default branch, and every other internal trigger
 * inherits the branch of the run that emitted its event. Those runs are matched
 * against the restriction patterns like any other. This phrase covers only the
 * runs where neither source produced one — a registration whose default branch
 * has never been captured, or an emitting run that is gone — so it names the
 * remedy for that case rather than telling an operator to drop the restriction.
 */
export const INTERNAL_TRIGGER_NO_BRANCH_DETAIL =
  'this internally-triggered run carries no branch, so no branch restriction can be ' +
  'satisfied — a scheduled run gains its branch after the next push to the default ' +
  'branch re-registers the workflow; alternatively bind a context without a branch ' +
  'restriction, or restrict by trigger type instead';

/** Evaluate branch restrictions, trigger type filters, and repo patterns. */
export function evaluateBranchGate(env: Context, ctx: JobDispatchContext): ProtectionGateResult {
  // Check branch restrictions
  if (env.branchRestrictions.length > 0) {
    // An internally-triggered run with an EMPTY branch genuinely has none, so
    // no pattern can match it. Say that, instead of printing the empty value as
    // a branch name the operator could go and add to the restriction list. A
    // run that does carry a branch falls through to the ordinary match below.
    if (ctx.internallyTriggered && !ctx.branch) {
      return {
        action: 'reject',
        reason: `Context '${env.name}' restricts branches: ${INTERNAL_TRIGGER_NO_BRANCH_DETAIL}`,
      };
    }
    const matches = env.branchRestrictions.some((pattern) =>
      picomatch.isMatch(ctx.branch, pattern),
    );
    if (!matches) {
      return {
        action: 'reject',
        reason: `Branch '${ctx.branch}' not allowed for context '${env.name}'`,
      };
    }
  }

  // Check trigger type filters
  if (env.triggerTypeFilters.length > 0) {
    const matches = env.triggerTypeFilters.some((filter) =>
      picomatch.isMatch(ctx.triggerType, filter),
    );
    if (!matches) {
      return {
        action: 'reject',
        reason: `Trigger type '${ctx.triggerType}' not allowed for context '${env.name}'`,
      };
    }
  }

  // Check repo patterns
  if (env.repoPatterns.length > 0) {
    const matches = env.repoPatterns.some((pattern) => picomatch.isMatch(ctx.repository, pattern));
    if (!matches) {
      return {
        action: 'reject',
        reason: `Repository '${ctx.repository}' not allowed for context '${env.name}'`,
      };
    }
  }

  return { action: 'pass' };
}
