/**
 * Unit tests for `evaluateSecurityPolicy` — the per-PR-event reader that turns
 * the stored org fork policy into a decision the pipeline enforces.
 *
 * Covers the properties the evaluator itself cannot: provider scoping, what an
 * unreadable policy means, and that a non-PR event is never gated.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPROVAL_EXPIRY_SECONDS, ForkPolicy, OrchestratorMode } from '@kici-dev/engine';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import { evaluateSecurityPolicy } from './process-webhook.js';
import { DEFAULT_FORK_POLICY } from '../security/trust-policy-gate.js';
import type { ProcessingDeps } from './processor.js';
import type { ProviderBundle } from '../provider-registry.js';

/** A bundle with a fork model (GitHub-shaped) — in scope for the gate. */
const GITHUB_BUNDLE = {
  normalizer: { provider: 'github' },
  hasForkModel: true,
} as unknown as ProviderBundle;

/** A bundle with no fork model (generic / local / universal-git). */
const GENERIC_BUNDLE = {
  normalizer: { provider: 'generic' },
} as unknown as ProviderBundle;

function depsWith(store: unknown): ProcessingDeps {
  return { trustPolicyStore: store } as unknown as ProcessingDeps;
}

function storedRow(forkPolicy: string) {
  return {
    forkPolicy,
    unknownContributorPolicy: 'hold',
    workflowChangePolicy: 'hold',
    // Deliberately hours-only: a stored row that predates the seconds column
    // reads NULL there, so the gate must still resolve a 72-hour window from
    // the hours field rather than inventing the default.
    approvalExpiryHours: 72,
    source: 'platform',
    updatedAt: new Date(),
  };
}

const BASE = {
  isPREvent: true,
  resolvedOrgId: 'org-1',
  mode: 'platform' as const,
  trustResolution: { tier: 'known' } as never,
  isForkPR: false,
};

describe('evaluateSecurityPolicy', () => {
  it('passes without reading the policy when the provider has no fork model', async () => {
    const get = vi.fn();
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get }),
      bundle: GENERIC_BUNDLE,
      isForkPR: true,
    });
    // universal-git computes an isForkPR signal; gating on it would silently
    // start dropping generic-source PRs that run freely today.
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
      isForkPR: true,
    });
    expect(outcome).toEqual({ action: 'pass' });
    expect(get).not.toHaveBeenCalled();
  });

  it('applies the stored fork policy to a PR from a fork-model provider', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(storedRow(ForkPolicy.enum.hold)) }),
      bundle: GITHUB_BUNDLE,
      isForkPR: true,
    });
    expect(outcome).toMatchObject({ action: 'hold', reason: SecurityHoldReason.enum.fork_pr });
  });

  it('ignores a fork PR when the stored fork policy says ignore', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(storedRow(ForkPolicy.enum.ignore)) }),
      bundle: GITHUB_BUNDLE,
      isForkPR: true,
    });
    expect(outcome).toEqual({ action: 'ignore' });
  });

  it('ignores a fork PR with no stored policy, in every mode', async () => {
    // The fail-closed default. An independent orchestrator has no upstream
    // authority, which is a reason to be stricter rather than more permissive.
    expect(DEFAULT_FORK_POLICY).toBe(ForkPolicy.enum.ignore);
    for (const mode of OrchestratorMode.options) {
      const outcome = await evaluateSecurityPolicy({
        ...BASE,
        deps: depsWith({ get: vi.fn().mockResolvedValue(null) }),
        bundle: GITHUB_BUNDLE,
        mode,
        isForkPR: true,
      });
      expect(outcome, `mode ${mode}`).toEqual({ action: 'ignore' });
    }
  });

  it('HOLDS when the policy read throws — it does not reuse the absent-row default', async () => {
    // An unreadable policy is not evidence that the PR is fine, and it is not
    // evidence the org left its policy unconfigured either. Answering both with
    // `ignore` would drop the fork PRs of an org that chose `hold` or `allow`,
    // leaving nothing behind but an orchestrator-side warning — a transient
    // database error turning into a silent disappearance. Holding is fail-closed
    // on the same terms and stays recoverable.
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockRejectedValue(new Error('db down')) }),
      bundle: GITHUB_BUNDLE,
      isForkPR: true,
    });
    expect(outcome).toMatchObject({
      action: 'hold',
      reason: SecurityHoldReason.enum.fork_pr,
      approvalExpirySeconds: DEFAULT_APPROVAL_EXPIRY_SECONDS,
    });
  });

  it('separates the two read outcomes: absent row ignores, thrown read holds', async () => {
    // The pair is the point. Asserting either alone would pass against a build
    // that collapsed them back together, which is the defect this pins.
    const absent = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(null) }),
      bundle: GITHUB_BUNDLE,
      isForkPR: true,
    });
    const threw = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockRejectedValue(new Error('db down')) }),
      bundle: GITHUB_BUNDLE,
      isForkPR: true,
    });
    expect(absent.action).toBe('ignore');
    expect(threw.action).toBe('hold');
  });

  it('a thrown read still passes a same-repo PR — the hold is scoped to forks', async () => {
    // The read-failure policy is a fork switch like any other, so the
    // evaluator's own guards run first. Holding every same-repo PR on a
    // database blip would be a far broader outage than the one it prevents.
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockRejectedValue(new Error('db down')) }),
      bundle: GITHUB_BUNDLE,
      isForkPR: false,
    });
    expect(outcome).toEqual({ action: 'pass' });
  });

  it('fails CLOSED when no trustPolicyStore is wired at all', async () => {
    // An unwired store yields no row rather than a failed read, so it takes the
    // absent-row answer: there is no stored policy to be wrong about.
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: {} as unknown as ProcessingDeps,
      bundle: GITHUB_BUNDLE,
      isForkPR: true,
    });
    expect(outcome).toEqual({ action: 'ignore' });
  });

  it('still applies a stored policy in independent mode', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(storedRow(ForkPolicy.enum.allow)) }),
      bundle: GITHUB_BUNDLE,
      mode: 'independent',
      isForkPR: true,
    });
    expect(outcome).toEqual({ action: 'pass' });
  });

  it('reads the policy for the resolved org, not a global one', async () => {
    const get = vi.fn().mockResolvedValue(storedRow(ForkPolicy.enum.hold));
    await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get }),
      bundle: GITHUB_BUNDLE,
      resolvedOrgId: 'org-42',
      isForkPR: true,
    });
    expect(get).toHaveBeenCalledWith('org-42');
  });

  it('does not gate a same-repo PR, whatever the stored policy', async () => {
    // Trust resolution returns `trusted` for a base-repo ref, and the fork
    // switch never fires on a non-fork event either — so the strictest policy
    // still passes an ordinary PR.
    for (const value of ForkPolicy.options) {
      const outcome = await evaluateSecurityPolicy({
        ...BASE,
        deps: depsWith({ get: vi.fn().mockResolvedValue(storedRow(value)) }),
        bundle: GITHUB_BUNDLE,
        trustResolution: { tier: 'trusted' } as never,
        isForkPR: false,
      });
      expect(outcome, `forkPolicy ${value}`).toEqual({ action: 'pass' });
    }
  });

  it('treats an unresolved trust resolution on a fork PR as untrusted', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(storedRow(ForkPolicy.enum.hold)) }),
      bundle: GITHUB_BUNDLE,
      trustResolution: undefined,
      isForkPR: true,
    });
    expect(outcome).toMatchObject({ action: 'hold', reason: SecurityHoldReason.enum.fork_pr });
  });

  it('passes a trusted contributor even under the strictest policy', async () => {
    const outcome = await evaluateSecurityPolicy({
      ...BASE,
      deps: depsWith({ get: vi.fn().mockResolvedValue(storedRow(ForkPolicy.enum.ignore)) }),
      bundle: GITHUB_BUNDLE,
      trustResolution: { tier: 'trusted' } as never,
      isForkPR: true,
    });
    expect(outcome).toEqual({ action: 'pass' });
  });
});
