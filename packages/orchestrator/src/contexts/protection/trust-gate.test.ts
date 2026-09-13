/**
 * Tests for trust gate -- minimumTrust evaluation against the ref's trust tier.
 */
import { describe, it, expect } from 'vitest';
import type { Context } from '@kici-dev/engine';
import { HoldType } from '@kici-dev/engine';
import { evaluateTrustGate } from './trust-gate.js';

// ── Fixtures ──────────────────────────────────────────────────────

function makeEnv(overrides: Partial<Context> = {}): Context {
  return {
    id: 'env-001',
    orgId: 'org-abc',
    name: 'production',
    type: 'fixed',
    globPattern: null,
    branchRestrictions: [],
    triggerTypeFilters: [],
    repoPatterns: [],
    concurrencyLimit: null,
    concurrencyStrategy: 'queue',
    concurrencyTimeoutMs: 1800000,
    requiredReviewers: null,
    waitTimerSeconds: null,
    holdExpirySeconds: 86400,
    enabled: true,
    createdAt: '2026-03-08T10:00:00Z',
    updatedAt: '2026-03-08T10:00:00Z',
    createdBy: 'user:admin',
    ...overrides,
  };
}

/**
 * Every value `Context['minimumTrust']` admits.
 *
 * Built from a `Record` over the union rather than written as a bare tuple, so
 * a member added to (or dropped from) `minimumTrust` fails the build here —
 * the same exhaustiveness device `TRUST_TIER_RANK` uses in the internal-event
 * pipeline. `Object.keys` widens to `string[]`, so the cast restores the narrow
 * element type it just lost.
 */
const MINIMUM_TRUST_VALUES = Object.keys({
  known: true,
  trusted: true,
} satisfies Record<NonNullable<Context['minimumTrust']>, true>) as ReadonlyArray<
  NonNullable<Context['minimumTrust']>
>;

// ── Tests ─────────────────────────────────────────────────────────

describe('evaluateTrustGate', () => {
  it('should pass when no minimumTrust configured', () => {
    const result = evaluateTrustGate(makeEnv(), 'unknown');
    expect(result.action).toBe('pass');
  });

  it.each(MINIMUM_TRUST_VALUES)(
    'should pass when trustTier is unresolved and minimumTrust is %s',
    (minimumTrust) => {
      const result = evaluateTrustGate(makeEnv({ minimumTrust }), undefined);
      expect(result.action).toBe('pass');
    },
  );

  // ── Both floors block exactly the fork tier ─────────────────
  //
  // Trust is ref-based, so `'unknown'` means the ref came from a fork and
  // `'trusted'` means it lives in the base repo. A context declaring either
  // floor asks the same question, so each table below drives both floors
  // through one assertion: a floor that stopped agreeing fails its own row.

  it.each(MINIMUM_TRUST_VALUES)(
    'should hold a fork ref when minimumTrust is %s',
    (minimumTrust) => {
      const result = evaluateTrustGate(makeEnv({ minimumTrust }), 'unknown');
      expect(result.action).toBe('hold');
      expect(result.holdType).toBe(HoldType.enum.security);
      expect(result.reason).toContain('unknown');
    },
  );

  it.each(MINIMUM_TRUST_VALUES)(
    'should pass a base-repo ref when minimumTrust is %s',
    (minimumTrust) => {
      const result = evaluateTrustGate(makeEnv({ minimumTrust }), 'trusted');
      expect(result.action).toBe('pass');
    },
  );

  it.each(MINIMUM_TRUST_VALUES)(
    'should pass the legacy known tier when minimumTrust is %s',
    (minimumTrust) => {
      // `resolveRefTrust` no longer produces `'known'`, but an
      // internally-triggered run can still inherit it from a stored
      // `execution_runs.trust_tier` row. It is not a fork ref, so it passes
      // both floors.
      const result = evaluateTrustGate(makeEnv({ minimumTrust }), 'known');
      expect(result.action).toBe('pass');
    },
  );

  // ── The declared floor selects the reason ──────────────────

  it('names the known floor when the context declares it', () => {
    const result = evaluateTrustGate(makeEnv({ minimumTrust: 'known' }), 'unknown');
    expect(result.reason).toContain('known contributors');
  });

  it('names the trusted floor when the context declares it', () => {
    const result = evaluateTrustGate(makeEnv({ minimumTrust: 'trusted' }), 'unknown');
    expect(result.reason).toContain('trusted contributors');
  });

  // ── Byte-identity pins ─────────────────────────────────────
  //
  // The reason text comes from the shared engine template that the ci-security
  // DB fixture and its assertions also read. These two pins compare the gate's
  // emitted bytes against literals, so a drift in that shared template — from
  // either side — fails here instead of silently changing what is persisted
  // into `held_runs.reason`.

  it('emits the exact known-contributor reason bytes', () => {
    const result = evaluateTrustGate(
      makeEnv({ name: 'ci-security-env', minimumTrust: 'known' }),
      'unknown',
    );
    expect(result.reason).toBe(
      "Context 'ci-security-env' requires known contributors (contributor is unknown)",
    );
  });

  it('emits the exact trusted-contributor reason bytes', () => {
    const result = evaluateTrustGate(
      makeEnv({ name: 'production', minimumTrust: 'trusted' }),
      'unknown',
    );
    expect(result.reason).toBe(
      "Context 'production' requires trusted contributors (contributor is unknown)",
    );
  });
});
