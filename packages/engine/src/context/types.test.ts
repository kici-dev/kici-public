import { describe, it, expect } from 'vitest';
import { MinimumTrustSchema, TrustTierSchema } from './types.js';

describe('TrustTierSchema', () => {
  // fails-when: 'known' is accepted by TrustTierSchema again
  it('rejects the removed known tier', () => {
    expect(TrustTierSchema.safeParse('known').success).toBe(false);
  });

  // breaks-if-wrong: the two live values still parse
  it('accepts the two ref-based tiers', () => {
    expect(TrustTierSchema.safeParse('trusted').success).toBe(true);
    expect(TrustTierSchema.safeParse('unknown').success).toBe(true);
  });
});

describe('MinimumTrustSchema', () => {
  // fails-when: a context can once more require the removed known tier
  it('rejects the removed known requirement', () => {
    expect(MinimumTrustSchema.safeParse('known').success).toBe(false);
  });

  // fails-when: the requirement widens to an arbitrary string again
  it('rejects a tier the trust gate does not compare against', () => {
    expect(MinimumTrustSchema.safeParse('unknown').success).toBe(false);
    expect(MinimumTrustSchema.safeParse('').success).toBe(false);
  });

  // breaks-if-wrong: setting and clearing the requirement must both still parse
  it('accepts the one requirement and its cleared form', () => {
    expect(MinimumTrustSchema.parse('trusted')).toBe('trusted');
    expect(MinimumTrustSchema.parse(null)).toBeNull();
  });
});
