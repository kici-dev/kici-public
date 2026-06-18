/**
 * Branch gate -- checks branch restrictions, trigger type filters, and repo patterns.
 */
import picomatch from 'picomatch';
import type { Environment, ProtectionGateResult } from '@kici-dev/engine';
import type { JobDispatchContext } from './pipeline.js';

/** Evaluate branch restrictions, trigger type filters, and repo patterns. */
export function evaluateBranchGate(
  env: Environment,
  ctx: JobDispatchContext,
): ProtectionGateResult {
  // Check branch restrictions
  if (env.branchRestrictions.length > 0) {
    const matches = env.branchRestrictions.some((pattern) =>
      picomatch.isMatch(ctx.branch, pattern),
    );
    if (!matches) {
      return {
        action: 'reject',
        reason: `Branch '${ctx.branch}' not allowed for environment '${env.name}'`,
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
        reason: `Trigger type '${ctx.triggerType}' not allowed for environment '${env.name}'`,
      };
    }
  }

  // Check repo patterns
  if (env.repoPatterns.length > 0) {
    const matches = env.repoPatterns.some((pattern) => picomatch.isMatch(ctx.repository, pattern));
    if (!matches) {
      return {
        action: 'reject',
        reason: `Repository '${ctx.repository}' not allowed for environment '${env.name}'`,
      };
    }
  }

  return { action: 'pass' };
}
