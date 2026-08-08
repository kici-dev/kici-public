/**
 * Tests for trust gate -- minimumTrust evaluation against contributor trust tier.
 */
import { describe, it, expect } from 'vitest';
import type { Context, TrustTier } from '@kici-dev/engine';
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

// ── Tests ─────────────────────────────────────────────────────────

describe('evaluateTrustGate', () => {
  it('should pass when no minimumTrust configured', () => {
    const result = evaluateTrustGate(makeEnv(), 'unknown');
    expect(result.action).toBe('pass');
  });

  it('should pass when trustTier is undefined (push event)', () => {
    const result = evaluateTrustGate(makeEnv({ minimumTrust: 'trusted' }), undefined);
    expect(result.action).toBe('pass');
  });

  // ── minimumTrust: 'trusted' ─────────────────────────────────

  it('should pass when minimumTrust is trusted and contributor is trusted', () => {
    const result = evaluateTrustGate(makeEnv({ minimumTrust: 'trusted' }), 'trusted');
    expect(result.action).toBe('pass');
  });

  it('should hold when minimumTrust is trusted and contributor is known', () => {
    const result = evaluateTrustGate(makeEnv({ minimumTrust: 'trusted' }), 'known');
    expect(result.action).toBe('hold');
    expect(result.holdType).toBe(HoldType.enum.security);
    expect(result.reason).toContain('trusted contributors');
    expect(result.reason).toContain('known');
  });

  it('should hold when minimumTrust is trusted and contributor is unknown', () => {
    const result = evaluateTrustGate(makeEnv({ minimumTrust: 'trusted' }), 'unknown');
    expect(result.action).toBe('hold');
    expect(result.holdType).toBe(HoldType.enum.security);
    expect(result.reason).toContain('trusted contributors');
    expect(result.reason).toContain('unknown');
  });

  // ── minimumTrust: 'known' ──────────────────────────────────

  it('should pass when minimumTrust is known and contributor is trusted', () => {
    const result = evaluateTrustGate(makeEnv({ minimumTrust: 'known' }), 'trusted');
    expect(result.action).toBe('pass');
  });

  it('should pass when minimumTrust is known and contributor is known', () => {
    const result = evaluateTrustGate(makeEnv({ minimumTrust: 'known' }), 'known');
    expect(result.action).toBe('pass');
  });

  it('should hold when minimumTrust is known and contributor is unknown', () => {
    const result = evaluateTrustGate(makeEnv({ minimumTrust: 'known' }), 'unknown');
    expect(result.action).toBe('hold');
    expect(result.holdType).toBe(HoldType.enum.security);
    expect(result.reason).toContain('known contributors');
    expect(result.reason).toContain('unknown');
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
      'known',
    );
    expect(result.reason).toBe(
      "Context 'production' requires trusted contributors (contributor is known)",
    );
  });
});
