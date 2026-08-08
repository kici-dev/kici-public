/**
 * Multi-context protection aggregation.
 *
 * When a job binds several contexts, every context's protection rules
 * must pass (all-must-pass / most restrictive). This module evaluates the hard
 * reject gates (enabled, branch, trigger, repo) per context — naming which
 * context and which rule rejected — and aggregates the hold/wait/queue
 * parameters (trust, reviewers, wait timer, hold expiry, concurrency) into a
 * single most-restrictive effective set.
 */
import picomatch from 'picomatch';
import {
  ContextGateRejectReason,
  DEFAULT_CONCURRENCY_STRATEGY,
  DEFAULT_HOLD_EXPIRY_SECONDS,
  type ConcurrencyStrategy,
  type Context,
} from '@kici-dev/engine';
import type { JobDispatchContext } from './pipeline.js';

/** A single context's rejection under all-must-pass aggregation. */
export interface ContextGateRejection {
  context: string;
  reason: ContextGateRejectReason;
  detail: string;
}

/** Effective protection parameters after most-restrictive aggregation. */
export interface EffectiveProtection {
  minimumTrust?: 'known' | 'trusted';
  requiredReviewers: string[];
  waitTimerSeconds: number | null;
  holdExpirySeconds: number;
  concurrencyLimit: number | null;
  concurrencyStrategy: ConcurrencyStrategy;
}

const TRUST_RANK: Record<'known' | 'trusted', number> = { known: 1, trusted: 2 };

/**
 * Evaluate each context's hard reject gates against the run context. A name
 * with no `Context` record yields a `context_not_found` rejection. Returns all
 * rejections (empty = every context passed the reject gates).
 */
export function evaluateMultiContextGates(
  envs: ReadonlyArray<{ name: string; env: Context | undefined }>,
  ctx: JobDispatchContext,
): ContextGateRejection[] {
  const rejections: ContextGateRejection[] = [];
  for (const { name, env } of envs) {
    if (!env) {
      rejections.push({
        context: name,
        reason: ContextGateRejectReason.enum.context_not_found,
        detail: `context '${name}' not found`,
      });
      continue;
    }
    if (!env.enabled) {
      rejections.push({
        context: name,
        reason: ContextGateRejectReason.enum.context_disabled,
        detail: `context '${name}' is disabled`,
      });
      continue;
    }
    const rule = firstFailingRule(env, ctx);
    if (rule) rejections.push({ context: name, ...rule });
  }
  return rejections;
}

/** Return the first failing branch/trigger/repo rule for a context, or null. */
function firstFailingRule(
  env: Context,
  ctx: JobDispatchContext,
): { reason: ContextGateRejectReason; detail: string } | null {
  if (
    env.branchRestrictions.length > 0 &&
    !env.branchRestrictions.some((p) => picomatch.isMatch(ctx.branch, p))
  ) {
    return {
      reason: ContextGateRejectReason.enum.branch_restricted,
      detail: `branch '${ctx.branch}' not allowed`,
    };
  }
  if (
    env.triggerTypeFilters.length > 0 &&
    !env.triggerTypeFilters.some((p) => picomatch.isMatch(ctx.triggerType, p))
  ) {
    return {
      reason: ContextGateRejectReason.enum.trigger_filtered,
      detail: `trigger type '${ctx.triggerType}' not allowed`,
    };
  }
  if (
    env.repoPatterns.length > 0 &&
    !env.repoPatterns.some((p) => picomatch.isMatch(ctx.repository, p))
  ) {
    return {
      reason: ContextGateRejectReason.enum.repo_unmatched,
      detail: `repository '${ctx.repository}' not allowed`,
    };
  }
  return null;
}

/**
 * Aggregate hold/wait/queue parameters across all bound contexts, most
 * restrictive wins: trust = max tier, reviewers = sorted dedup union, wait timer
 * = max, hold expiry = min, concurrency limit = min (tightest). The concurrency
 * strategy follows the primary (first) context.
 */
export function aggregateProtectionParams(envs: ReadonlyArray<Context>): EffectiveProtection {
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
    holdExpirySeconds: Number.isFinite(holdExpirySeconds)
      ? holdExpirySeconds
      : DEFAULT_HOLD_EXPIRY_SECONDS,
    concurrencyLimit,
    concurrencyStrategy: envs[0]?.concurrencyStrategy ?? DEFAULT_CONCURRENCY_STRATEGY,
  };
}

/**
 * Build a synthetic `Context` carrying the aggregated protection parameters,
 * so the existing per-rule gate functions (trust/concurrency/reviewer/wait) can
 * evaluate the all-must-pass holds in one pass. Branch/trigger/repo/enabled are
 * already handled by `evaluateMultiContextGates`, so they are neutralized here.
 */
export function buildEffectiveContext(primary: Context, eff: EffectiveProtection): Context {
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
export function formatMultiContextRejection(
  rejections: ReadonlyArray<ContextGateRejection>,
): string {
  return rejections
    .map((r) => `multi-context gate: '${r.context}' rejected (${r.reason}: ${r.detail})`)
    .join('; ');
}
