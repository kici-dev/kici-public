import { describe, it, expect } from 'vitest';
import { resolveTrustForPR } from './process-webhook.js';

/**
 * Trust derives from the git ref alone: every base-repo ref is trusted (only a
 * write-or-higher contributor can create one); a fork head ref resolves to
 * `unknown`.
 *
 * The tier feeds `deriveCacheRefScope` (trusted → org-shared cache, else
 * per-run isolated) and lock-file-source selection (`head` for a trusted PR
 * ref, `base` otherwise).
 *
 * A PR resolves a tier only for a provider with `hasForkModel`; elsewhere the
 * fork signal fails toward trust, so such a PR resolves nothing and reads the
 * base lock.
 */

function makeArgs(opts: {
  event: string;
  targetBranch: string;
  defaultBranch: string;
  senderUsername?: string;
  /** When true, the bundle is a provider with a fork model (GitHub). */
  hasForkModel?: boolean;
  isForkPR?: boolean;
}) {
  return {
    info: { event: opts.event, provider: 'local', routingKey: 'rk' } as never,
    bundle: {
      normalizer: {
        extractDefaultBranch: () => opts.defaultBranch,
      },
      hasForkModel: opts.hasForkModel,
    } as never,
    event: {
      targetBranch: opts.targetBranch,
      senderUsername: opts.senderUsername,
      isForkPR: opts.isForkPR,
    } as never,
    payload: { repository: { default_branch: opts.defaultBranch } },
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
        hasForkModel: true,
      }),
    );
    expect(out.trustResolution).toBeDefined();
    expect(out.trustResolution!.tier).toBe('trusted');
    expect(out.trustResolution!.contributorUsername).toBe('octo');
  });

  it('marks any non-PR event from a fork-less provider as trusted', async () => {
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

  it('marks a non-default-branch push from a fork-model provider as trusted', async () => {
    // Only a write-or-higher contributor can create a base-repo ref.
    const out = await resolveTrustForPR(
      makeArgs({
        event: 'push',
        targetBranch: 'feature/x',
        defaultBranch: 'master',
        senderUsername: 'octo',
        hasForkModel: true,
      }),
    );
    expect(out.trustResolution).toBeDefined();
    expect(out.trustResolution!.tier).toBe('trusted');
    expect(out.trustResolution!.reason).toContain('same-repo ref');
  });
});

describe('resolveTrustForPR — PR trust resolution', () => {
  it('resolves a same-repo PR as trusted and reads the head lock file', async () => {
    const out = await resolveTrustForPR(
      makeArgs({
        event: 'pull_request',
        targetBranch: 'master',
        defaultBranch: 'master',
        senderUsername: 'octo',
        hasForkModel: true,
        isForkPR: false,
      }),
    );
    expect(out.trustResolution).toBeDefined();
    expect(out.trustResolution!.tier).toBe('trusted');
    expect(out.lockFileSource).toBe('head');
  });

  it('resolves a fork PR as unknown and falls back to the base lock file', async () => {
    const out = await resolveTrustForPR(
      makeArgs({
        event: 'pull_request',
        targetBranch: 'master',
        defaultBranch: 'master',
        senderUsername: 'stranger',
        hasForkModel: true,
        isForkPR: true,
      }),
    );
    expect(out.trustResolution).toBeDefined();
    expect(out.trustResolution!.tier).toBe('unknown');
    expect(out.trustResolution!.contributorUsername).toBe('stranger');
    expect(out.lockFileSource).toBe('base');
  });

  it('resolves a PR with no sender username rather than returning nothing', async () => {
    const out = await resolveTrustForPR(
      makeArgs({
        event: 'pull_request',
        targetBranch: 'master',
        defaultBranch: 'master',
        hasForkModel: true,
        isForkPR: true,
      }),
    );
    expect(out.trustResolution).toBeDefined();
    expect(out.trustResolution!.tier).toBe('unknown');
    expect(out.trustResolution!.contributorUsername).toBe('');
  });

  it('resolves no tier for a PR from a provider with no fork model', async () => {
    // universal-git's `isForkPR` (Gitea/Gogs/GitLab) reads `false` when a forge
    // omits either repo-name payload key; trusting it would hand a fork's HEAD
    // lock file to trigger evaluation.
    const out = await resolveTrustForPR(
      makeArgs({
        event: 'pull_request',
        targetBranch: 'master',
        defaultBranch: 'master',
        senderUsername: 'stranger',
        isForkPR: false,
      }),
    );
    expect(out.trustResolution).toBeUndefined();
    expect(out.lockFileSource).toBe('base');
  });
});
