import { z } from 'zod';

/**
 * Plan tier discriminator. Single source of truth for the four hosted tiers
 * (`free`, `pro`, `team`, `business`); Enterprise is `pro` / `team` /
 * `business` with a custom `plan_config` override, not a tier of its own.
 *
 * Lives in the engine rather than the Platform package because the browser
 * dashboard needs the same vocabulary and cannot import a private package.
 * Pure Zod with no Node built-ins, so it is safe on the engine barrel.
 *
 * Use `PlanType` (the Zod schema) inside other schemas; use `PlanType.enum.X`
 * to reference a specific value in code; use `type PlanType` for the derived
 * TypeScript type.
 */
export const PlanType = z.enum(['free', 'pro', 'team', 'business']);
export type PlanType = z.infer<typeof PlanType>;

/**
 * The purchasable subset of `PlanType`. `free` is the default state an org
 * lands in, never something checkout can be started for, so every checkout /
 * upgrade / subscription-metadata surface takes this narrower enum instead of
 * re-spelling the three paid tiers by hand.
 */
export const PaidPlanType = PlanType.exclude(['free']);
export type PaidPlanType = z.infer<typeof PaidPlanType>;

/** Every hosted tier, in ascending rank order. */
export const PLAN_TYPES: readonly PlanType[] = PlanType.options;

/**
 * Narrow a tier to the purchasable subset (everything except `free`). Derived
 * from `PaidPlanType`, so a new paid tier needs no edit here and no edit at any
 * call site that used to spell the paid set out as a boolean chain.
 */
export function isPaidTier(tier: PlanType): tier is PaidPlanType {
  return PaidPlanType.safeParse(tier).success;
}

/**
 * Monotonic tier rank for up/down comparison. free < pro < team < business.
 *
 * Typed `Record<PlanType, number>` on purpose: adding a tier to the enum
 * without ranking it fails `pnpm typecheck` instead of silently yielding
 * `undefined` at runtime.
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
 * The `Object.hasOwn` guard is not defensive padding: a bare index into an
 * object literal inherits `Object.prototype`, so `planRank('toString')` would
 * return a *function* rather than a number, and any `??`-style fallback a
 * caller wrapped it in would never fire. Every current caller passes a
 * `safeParse`d tier, so the throw is unreachable in practice — but a loud
 * error beats silently ranking a forged string above `business`.
 */
export function planRank(p: PlanType): number {
  if (!Object.hasOwn(PLAN_RANK, p)) {
    throw new Error(`planRank: '${String(p)}' is not a plan tier`);
  }
  return PLAN_RANK[p];
}
