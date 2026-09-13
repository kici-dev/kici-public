import { describe, expect, it } from 'vitest';
import { PLAN_TYPES, PaidPlanType, PlanType, isPaidTier, planRank } from './plan-type.js';

describe('PlanType', () => {
  it('carries exactly the four hosted tiers, in ascending rank order', () => {
    expect(PlanType.options).toEqual(['free', 'pro', 'team', 'business']);
    expect(PLAN_TYPES).toEqual(['free', 'pro', 'team', 'business']);
  });

  it('rejects a tier that does not exist', () => {
    expect(PlanType.safeParse('enterprise').success).toBe(false);
    expect(PlanType.safeParse('').success).toBe(false);
  });

  it('parses every declared tier', () => {
    for (const tier of PLAN_TYPES) {
      expect(PlanType.parse(tier)).toBe(tier);
    }
  });
});

describe('PaidPlanType', () => {
  it('is PlanType minus free', () => {
    expect(PaidPlanType.options).toEqual(['pro', 'team', 'business']);
  });

  it('rejects free', () => {
    expect(PaidPlanType.safeParse('free').success).toBe(false);
  });

  it('stays a strict subset of PlanType', () => {
    for (const tier of PaidPlanType.options) {
      expect(PlanType.options).toContain(tier);
    }
  });
});

describe('isPaidTier', () => {
  it('accepts every paid tier and rejects free', () => {
    for (const tier of PLAN_TYPES) {
      expect(isPaidTier(tier)).toBe(tier !== PlanType.enum.free);
    }
  });

  it('agrees with PaidPlanType.options for every declared tier', () => {
    const accepted = PLAN_TYPES.filter(isPaidTier);
    expect(accepted).toEqual([...PaidPlanType.options]);
  });

  /**
   * A `Set`-free predicate built on `safeParse` cannot walk `Object.prototype`,
   * so an untrusted string never resolves to an inherited member.
   */
  it('rejects prototype-chain keys and unknown strings', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'enterprise']) {
      expect(isPaidTier(key as PlanType)).toBe(false);
    }
  });
});

describe('planRank', () => {
  it('is strictly monotonic across the declared tier order', () => {
    const ranks = PLAN_TYPES.map(planRank);
    expect(ranks).toEqual([0, 1, 2, 3]);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]!);
    }
  });

  it('ranks an upgrade above a downgrade', () => {
    expect(planRank(PlanType.enum.business)).toBeGreaterThan(planRank(PlanType.enum.pro));
    expect(planRank(PlanType.enum.free)).toBeLessThan(planRank(PlanType.enum.team));
  });

  /**
   * The rank table is a `Record<PlanType, number>`, so a fifth tier added to the
   * enum fails `pnpm typecheck` rather than silently returning `undefined` here.
   * This test is the runtime half of that guarantee: every declared tier — not
   * just the four spelled out above — resolves to a real integer rank.
   */
  it('has a rank for every declared tier (no undefined holes)', () => {
    for (const tier of PLAN_TYPES) {
      expect(Number.isInteger(planRank(tier))).toBe(true);
    }
  });

  it('throws on a prototype-chain key instead of returning an inherited member', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(() => planRank(key as PlanType)).toThrow(/is not a plan tier/);
    }
  });

  it('throws on an unknown tier rather than ranking it', () => {
    expect(() => planRank('enterprise' as PlanType)).toThrow(/is not a plan tier/);
  });
});
