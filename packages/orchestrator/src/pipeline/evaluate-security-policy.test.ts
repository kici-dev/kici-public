/**
 * Unit tests for `evaluateSecurityPolicy` — the per-PR-event reader that turns
 * the stored org trust policy into a decision the dispatch gate enforces.
 *
 * Covers the three properties the evaluator itself cannot: provider scoping,
 * what an unreadable policy means, and that a non-PR event is never gated.
 */
import { describe, expect, it, vi } from 'vitest';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import { evaluateSecurityPolicy } from './process-webhook.js';
import type { ProcessingDeps } from './processor.js';
import type { ProviderBundle } from '../provider-registry.js';

/** A bundle with a contributor model (GitHub-shaped) — in scope for the gate. */
const GITHUB_BUNDLE = {
  normalizer: { provider: 'github' },
  contributorResolver: { provider: 'github' },
} as unknown as ProviderBundle;

/** A bundle with no contributor model (generic / local / universal-git). */
const GENERIC_BUNDLE = {
  normalizer: { provider: 'generic' },
} as unknown as ProviderBundle;

function depsWith(store: unknown): ProcessingDeps {
  return { trustPolicyStore: store } as unknown as ProcessingDeps;
}

const STRICT_ROW = {
  forkPolicy: 'reject',
  unknownContributorPolicy: 'hold',
  workflowChangePolicy: 'hold',
  approvalExpiryHours: 72,
  source: 'platform',
  updatedAt: new Date(),
};

const BASE = {
  isPREvent: true,
  resolvedOrgId: 'org-1',
  mode: 'platform' as const,
  trustResolution: { tier: 'known' } as never,
  isForkPR: false,
  hasWorkflowModifications: false,
};

describe('evaluateSecurityPolicy', () => {
  it('passes without reading the policy when the provider has no contributor model', async () => {
    const get = vi.fn();
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get }),
      bundle: GENERIC_BUNDLE,
      isForkPR: true,
      hasWorkflowModifications: true,
    });
    // universal-git computes an isForkPR signal; gating on it would silently
    // start holding generic-source PRs that run freely today.
    expect(outcome).toEqual({ action: 'pass' });
    expect(get).not.toHaveBeenCalled();
  });

  it('passes without reading the policy for a non-PR event', async () => {
    const get = vi.fn();
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get }),
      bundle: GITHUB_BUNDLE,
      isPREvent: false,
      hasWorkflowModifications: true,
    });
    expect(outcome).toEqual({ action: 'pass' });
    expect(get).not.toHaveBeenCalled();
  });

  it('applies the stored policy to a PR from a contributor-model provider', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(STRICT_ROW) }),
      bundle: GITHUB_BUNDLE,
      isForkPR: true,
    });
    expect(outcome).toMatchObject({
      action: 'reject',
      reason: SecurityHoldReason.enum.fork_pr,
    });
  });

  it('fails CLOSED when the policy read throws on a Platform-attached orchestrator', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockRejectedValue(new Error('db down')) }),
      bundle: GITHUB_BUNDLE,
      isForkPR: true,
    });
    // An unreadable policy is not evidence that the PR is fine.
    expect(outcome).toMatchObject({
      action: 'hold',
      reason: SecurityHoldReason.enum.fork_pr,
    });
  });

  it('fails CLOSED when no policy row exists on a Platform-attached orchestrator', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(null) }),
      bundle: GITHUB_BUNDLE,
      isForkPR: true,
    });
    expect(outcome).toMatchObject({ action: 'hold', reason: SecurityHoldReason.enum.fork_pr });
  });

  it('fails CLOSED when no trustPolicyStore is wired at all', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: {} as unknown as ProcessingDeps,
      bundle: GITHUB_BUNDLE,
      isForkPR: true,
    });
    expect(outcome).toMatchObject({ action: 'hold', reason: SecurityHoldReason.enum.fork_pr });
  });

  it('keeps legacy behavior in independent mode with no stored policy', async () => {
    // An independent orchestrator has no upstream authority, so an upgrade must
    // not silently start gating fork PRs that ran freely before.
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(null) }),
      bundle: GITHUB_BUNDLE,
      mode: 'independent',
      isForkPR: true,
    });
    expect(outcome).toEqual({ action: 'pass' });
  });

  it('still applies a stored policy in independent mode', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(STRICT_ROW) }),
      bundle: GITHUB_BUNDLE,
      mode: 'independent',
      isForkPR: true,
    });
    expect(outcome).toMatchObject({ action: 'reject' });
  });

  it('reads the policy for the resolved org, not a global one', async () => {
    const get = vi.fn().mockResolvedValue(STRICT_ROW);
    await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get }),
      bundle: GITHUB_BUNDLE,
      resolvedOrgId: 'org-42',
      isForkPR: true,
    });
    expect(get).toHaveBeenCalledWith('org-42');
  });

  it('treats an unresolved trust resolution as unknown', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(STRICT_ROW) }),
      bundle: GITHUB_BUNDLE,
      trustResolution: undefined,
    });
    expect(outcome).toMatchObject({
      action: 'hold',
      reason: SecurityHoldReason.enum.unknown_contributor,
    });
  });

  it('passes a trusted contributor even under the strictest policy', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(STRICT_ROW) }),
      bundle: GITHUB_BUNDLE,
      trustResolution: { tier: 'trusted' } as never,
      isForkPR: true,
      hasWorkflowModifications: true,
    });
    expect(outcome).toEqual({ action: 'pass' });
  });
});
