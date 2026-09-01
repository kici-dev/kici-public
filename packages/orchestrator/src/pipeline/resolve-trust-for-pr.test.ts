import { describe, it, expect } from 'vitest';
import { resolveTrustForPR } from './process-webhook.js';

/**
 * Trust resolution is derived from the git ref alone. Every ref in the base
 * repo is trusted — a default-branch push, a topic-branch push, a same-repo PR
 * — because only a write-or-higher contributor can put a ref there. A fork
 * head ref is the single untrusted case and resolves to `unknown`.
 *
 * The tier feeds two consumers: `deriveCacheRefScope` (trusted → org-shared
 * cache, everything else → per-run isolated) and lock-file-source selection
 * (`head` for a trusted PR ref, `base` otherwise).
 *
 * A PR event resolves a tier only for a provider that sets `hasForkModel`.
 * Elsewhere the fork signal is read from fixed payload keys many forges omit,
 * so it fails toward trust; such a PR deliberately resolves nothing and reads
 * the base lock.
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
    // The ref lives in the base repo, so only a write-or-higher contributor
    // could have created it.
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
    // universal-git normalizes Gitea/Gogs/GitLab pull_request events and reports
    // an `isForkPR` built from two repo names read off fixed payload keys that
    // many forges omit, which reads `false` when either is absent. Trusting it
    // would hand a fork's HEAD lock file to trigger evaluation.
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
