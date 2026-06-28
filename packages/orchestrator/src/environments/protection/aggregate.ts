/**
 * Multi-environment protection aggregation.
 *
 * When a job binds several environments, every environment's protection rules
 * must pass (all-must-pass / most restrictive). This module evaluates the hard
 * reject gates (enabled, branch, trigger, repo) per environment — naming which
 * environment and which rule rejected — and aggregates the hold/wait/queue
 * parameters (trust, reviewers, wait timer, hold expiry, concurrency) into a
 * single most-restrictive effective set.
 */
import picomatch from 'picomatch';
import { EnvGateRejectReason, type Environment } from '@kici-dev/engine';
import type { JobDispatchContext } from './pipeline.js';

/** A single environment's rejection under all-must-pass aggregation. */
export interface EnvGateRejection {
  environment: string;
  reason: EnvGateRejectReason;
  detail: string;
}

/** Effective protection parameters after most-restrictive aggregation. */
export interface EffectiveProtection {
  minimumTrust?: 'known' | 'trusted';
  requiredReviewers: string[];
  waitTimerSeconds: number | null;
  holdExpirySeconds: number;
  concurrencyLimit: number | null;
  concurrencyStrategy: 'queue' | 'cancel-pending';
}

const TRUST_RANK: Record<'known' | 'trusted', number> = { known: 1, trusted: 2 };

/**
 * Evaluate each environment's hard reject gates against the run context. A name
 * with no `Environment` record yields an `env_not_found` rejection. Returns all
 * rejections (empty = every environment passed the reject gates).
 */
export function evaluateMultiEnvGates(
  envs: ReadonlyArray<{ name: string; env: Environment | undefined }>,
  ctx: JobDispatchContext,
): EnvGateRejection[] {
  const rejections: EnvGateRejection[] = [];
  for (const { name, env } of envs) {
    if (!env) {
      rejections.push({
        environment: name,
        reason: EnvGateRejectReason.enum.env_not_found,
        detail: `environment '${name}' not found`,
      });
      continue;
    }
    if (!env.enabled) {
      rejections.push({
        environment: name,
        reason: EnvGateRejectReason.enum.env_disabled,
        detail: `environment '${name}' is disabled`,
      });
      continue;
    }
    const rule = firstFailingRule(env, ctx);
    if (rule) rejections.push({ environment: name, ...rule });
  }
  return rejections;
}

/** Return the first failing branch/trigger/repo rule for an environment, or null. */
function firstFailingRule(
  env: Environment,
  ctx: JobDispatchContext,
): { reason: EnvGateRejectReason; detail: string } | null {
  if (
    env.branchRestrictions.length > 0 &&
    !env.branchRestrictions.some((p) => picomatch.isMatch(ctx.branch, p))
  ) {
    return {
      reason: EnvGateRejectReason.enum.branch_restricted,
      detail: `branch '${ctx.branch}' not allowed`,
    };
  }
  if (
    env.triggerTypeFilters.length > 0 &&
    !env.triggerTypeFilters.some((p) => picomatch.isMatch(ctx.triggerType, p))
  ) {
    return {
      reason: EnvGateRejectReason.enum.trigger_filtered,
      detail: `trigger type '${ctx.triggerType}' not allowed`,
    };
  }
  if (
    env.repoPatterns.length > 0 &&
    !env.repoPatterns.some((p) => picomatch.isMatch(ctx.repository, p))
  ) {
    return {
      reason: EnvGateRejectReason.enum.repo_unmatched,
      detail: `repository '${ctx.repository}' not allowed`,
    };
  }
  return null;
}

/**
 * Aggregate hold/wait/queue parameters across all bound environments, most
 * restrictive wins: trust = max tier, reviewers = sorted dedup union, wait timer
 * = max, hold expiry = min, concurrency limit = min (tightest). The concurrency
 * strategy follows the primary (first) environment.
 */
export function aggregateProtectionParams(envs: ReadonlyArray<Environment>): EffectiveProtection {
  let minimumTrust: 'known' | 'trusted' | undefined;
  const reviewers = new Set<string>();
  let waitTimerSeconds: number | null = null;
  let holdExpirySeconds = Number.POSITIVE_INFINITY;
  let concurrencyLimit: number | null = null;

  for (const env of envs) {
    if (
      env.minimumTrust &&
      (!minimumTrust || TRUST_RANK[env.minimumTrust] > TRUST_RANK[minimumTrust])
    ) {
      minimumTrust = env.minimumTrust;
    }
    for (const r of env.requiredReviewers ?? []) reviewers.add(r);
    if (env.waitTimerSeconds !== null) {
      waitTimerSeconds = Math.max(waitTimerSeconds ?? 0, env.waitTimerSeconds);
    }
    holdExpirySeconds = Math.min(holdExpirySeconds, env.holdExpirySeconds);
    if (env.concurrencyLimit !== null) {
      concurrencyLimit =
        concurrencyLimit === null
          ? env.concurrencyLimit
          : Math.min(concurrencyLimit, env.concurrencyLimit);
    }
  }

  return {
    minimumTrust,
    requiredReviewers: [...reviewers].sort(),
    waitTimerSeconds,
    holdExpirySeconds: Number.isFinite(holdExpirySeconds) ? holdExpirySeconds : 3600,
    concurrencyLimit,
    concurrencyStrategy: envs[0]?.concurrencyStrategy ?? 'queue',
  };
}

/**
 * Build a synthetic `Environment` carrying the aggregated protection parameters,
 * so the existing per-rule gate functions (trust/concurrency/reviewer/wait) can
 * evaluate the all-must-pass holds in one pass. Branch/trigger/repo/enabled are
 * already handled by `evaluateMultiEnvGates`, so they are neutralized here.
 */
export function buildEffectiveEnvironment(
  primary: Environment,
  eff: EffectiveProtection,
): Environment {
  return {
    ...primary,
    branchRestrictions: [],
    triggerTypeFilters: [],
    repoPatterns: [],
    enabled: true,
    minimumTrust: eff.minimumTrust,
    requiredReviewers: eff.requiredReviewers.length > 0 ? eff.requiredReviewers : null,
    waitTimerSeconds: eff.waitTimerSeconds,
    holdExpirySeconds: eff.holdExpirySeconds,
    concurrencyLimit: eff.concurrencyLimit,
    concurrencyStrategy: eff.concurrencyStrategy,
  };
}

/** Format a human-readable rejection reason naming the env(s) and rule(s). */
export function formatMultiEnvRejection(rejections: ReadonlyArray<EnvGateRejection>): string {
  return rejections
    .map((r) => `multi-environment gate: '${r.environment}' rejected (${r.reason}: ${r.detail})`)
    .join('; ');
}
