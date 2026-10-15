import { z } from 'zod';

/**
 * Plan tier discriminator for the four hosted tiers. Enterprise is `pro` /
 * `team` / `business` with a custom `plan_config` override, not a tier of its
 * own.
 *
 * Lives in the engine because the browser dashboard needs the same vocabulary
 * and cannot import the private Platform package. Pure Zod with no Node
 * built-ins, so it is safe on the engine barrel.
 */
export const PlanType = z.enum(['free', 'pro', 'team', 'business']);
export type PlanType = z.infer<typeof PlanType>;

/**
 * The purchasable subset of `PlanType`. `free` is the default state of an org
 * and never a checkout target, so every checkout / upgrade /
 * subscription-metadata surface takes this enum instead of spelling out the
 * paid tiers.
 */
export const PaidPlanType = PlanType.exclude(['free']);
export type PaidPlanType = z.infer<typeof PaidPlanType>;

/** Every hosted tier, in ascending rank order. */
export const PLAN_TYPES: readonly PlanType[] = PlanType.options;

/**
 * Narrow a tier to the purchasable subset. Derived from `PaidPlanType`, so a
 * new paid tier needs no edit here or at any call site.
 */
export function isPaidTier(tier: PlanType): tier is PaidPlanType {
  return PaidPlanType.safeParse(tier).success;
}

/**
 * Monotonic tier rank: free < pro < team < business. Typed
 * `Record<PlanType, number>` so a new enum tier without a rank fails
 * `pnpm typecheck` instead of yielding `undefined` at runtime.
 */
const PLAN_RANK: Record<PlanType, number> = {
  [PlanType.enum.free]: 0,
  [PlanType.enum.pro]: 1,
  [PlanType.enum.team]: 2,
  [PlanType.enum.business]: 3,
};

/**
 * Rank a plan tier for up/down direction comparisons.
 *
 * The `Object.hasOwn` guard matters: a bare index inherits `Object.prototype`,
 * so `planRank('toString')` would return a function, and a caller's
 * `??`-style fallback would never fire. Every current caller passes a
 * `safeParse`d tier, so the throw is unreachable in practice, but a loud error
 * beats silently ranking a forged string above `business`.
 */
export function planRank(p: PlanType): number {
  if (!Object.hasOwn(PLAN_RANK, p)) {
    throw new Error(`planRank: '${String(p)}' is not a plan tier`);
  }
  return PLAN_RANK[p];
}
