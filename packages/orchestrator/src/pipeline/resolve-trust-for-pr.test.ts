import { describe, it, expect } from 'vitest';
import { resolveTrustForPR } from './process-webhook.js';

/**
 * Focused coverage for the trust-resolution phase's non-PR branches that feed
 * the user-cache write scope (`deriveCacheRefScope` maps tier 'trusted' →
 * shared, everything else → isolated):
 *
 *   1. A push to the repo's default branch is trusted (only a write-or-higher
 *      contributor can land a commit there).
 *   2. A non-PR event from a provider with no contributor model (generic /
 *      internal source — the verification secret is the trust boundary) is
 *      trusted by construction.
 *   3. A non-default-branch push from a real provider (one that HAS a
 *      contributor resolver) carries no trust resolution (fails closed →
 *      isolated).
 */

function makeArgs(opts: {
  event: string;
  targetBranch: string;
  defaultBranch: string;
  senderUsername?: string;
  /** When true, the bundle exposes a contributor resolver (real provider). */
  hasContributorResolver?: boolean;
}) {
  return {
    info: { event: opts.event, provider: 'local', routingKey: 'rk' } as never,
    deps: { trustResolver: undefined } as never,
    bundle: {
      normalizer: {
        extractDefaultBranch: () => opts.defaultBranch,
      },
      contributorResolver: opts.hasContributorResolver ? ({} as never) : undefined,
    } as never,
    event: {
      targetBranch: opts.targetBranch,
      senderUsername: opts.senderUsername,
    } as never,
    payload: { repository: { default_branch: opts.defaultBranch } },
    resolvedOrgId: 'org-1',
    repoIdentifier: '.',
    credentials: {},
  };
}

describe('resolveTrustForPR — non-PR trust resolution', () => {
  it('marks a default-branch push as trusted (shared cache scope)', async () => {
    const out = await resolveTrustForPR(
      makeArgs({
        event: 'push',
        targetBranch: 'master',
        defaultBranch: 'master',
        senderUsername: 'octo',
        hasContributorResolver: true,
      }),
    );
    expect(out.trustResolution).toBeDefined();
    expect(out.trustResolution!.tier).toBe('trusted');
    expect(out.trustResolution!.contributorUsername).toBe('octo');
  });

  it('marks any non-PR event from a contributor-less provider as trusted', async () => {
    // generic/internal source firing a custom (non-push) event on any branch.
    const out = await resolveTrustForPR(
      makeArgs({
        event: 'e2e-user-cache-trigger',
        targetBranch: 'master',
        defaultBranch: 'master',
        senderUsername: 'webhook',
      }),
    );
    expect(out.trustResolution).toBeDefined();
    expect(out.trustResolution!.tier).toBe('trusted');
  });

  it('does not mark a non-default-branch push from a real provider as trusted', async () => {
    const out = await resolveTrustForPR(
      makeArgs({
        event: 'push',
        targetBranch: 'feature/x',
        defaultBranch: 'master',
        hasContributorResolver: true,
      }),
    );
    expect(out.trustResolution).toBeUndefined();
  });
});
