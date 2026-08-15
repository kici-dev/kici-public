import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { UniversalGitWebhookNormalizer } from './normalizer.js';
import type { UniversalGitConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, 'fixtures');

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'));
}

function baseConfig(overrides: Partial<UniversalGitConfig> = {}): UniversalGitConfig {
  return {
    preset: 'forgejo',
    gitUrlTemplate: 'https://forgejo.example.com/{owner}/{name}.git',
    credentialRef: { key: 'pat' },
    credentialType: 'pat',
    sshHostKeyPolicy: 'accept-new',
    ...overrides,
  };
}

describe('UniversalGitWebhookNormalizer — forgejo preset', () => {
  const normalizer = new UniversalGitWebhookNormalizer({
    routingKey: 'generic:org:src',
    config: baseConfig(),
  });
  const push = loadFixture('forgejo-push.json');

  it('extractRoutingKey falls back to the source routing key', () => {
    expect(normalizer.extractRoutingKey({}, push)).toBe('generic:org:src');
  });

  it('extractRoutingKey honours explicit x-kici-source-id header', () => {
    expect(normalizer.extractRoutingKey({ 'x-kici-source-id': 'override:1' }, push)).toBe(
      'override:1',
    );
  });

  it('extractDeliveryId reads Forgejo/Gitea delivery header', () => {
    expect(normalizer.extractDeliveryId({ 'x-gitea-delivery': 'd-1' })).toBe('d-1');
  });

  it('extractEventType reads x-gitea-event / x-gogs-event', () => {
    expect(normalizer.extractEventType({ 'x-gitea-event': 'push' })).toBe('push');
    expect(normalizer.extractEventType({ 'x-gogs-event': 'push' })).toBe('push');
  });

  it('verifySignature always returns true (upstream handles it)', () => {
    expect(normalizer.verifySignature('body', {}, 'secret')).toBe(true);
  });

  it('normalizeEvent(push) returns targetBranch stripped of refs/heads/', () => {
    const ev = normalizer.normalizeEvent('push', null, push);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('push');
    expect(ev!.targetBranch).toBe('main');
    expect(ev!.senderUsername).toBe('alice');
    expect(ev!.provider).toBe('generic');
  });

  it('normalizeEvent maps refs/tags/ to type=tag', () => {
    const tagPush = { ...push, ref: 'refs/tags/v1.2.3' };
    const ev = normalizer.normalizeEvent('push', null, tagPush);
    expect(ev!.type).toBe('tag');
    expect(ev!.targetBranch).toBe('v1.2.3');
  });

  it('normalizeEvent returns null for unmapped event types', () => {
    expect(normalizer.normalizeEvent('issue_comment', 'created', push)).toBeNull();
  });

  it('normalizeEvent(pull_request) extracts base/head + fork detection', () => {
    const pr = loadFixture('forgejo-pull_request.json');
    const ev = normalizer.normalizeEvent('pull_request', 'opened', pr);
    expect(ev).not.toBeNull();
    expect(ev!.type).toBe('pull_request');
    expect(ev!.targetBranch).toBe('main');
    expect(ev!.sourceBranch).toBe('feature-x');
    expect(ev!.isForkPR).toBe(false);
    expect(ev!.action).toBe('opened');
  });

  it('normalizeEvent flags fork PRs when head/base repos differ', () => {
    const pr = loadFixture('forgejo-pull_request.json');
    const fork = structuredClone(pr);
    (fork.pull_request as any).head.repo.full_name = 'alice-fork/sample-repo';
    const ev = normalizer.normalizeEvent('pull_request', 'opened', fork);
    expect(ev!.isForkPR).toBe(true);
  });

  it('extractRepoIdentifier pulls repository.full_name', () => {
    expect(normalizer.extractRepoIdentifier(push)).toBe('kici-dev/sample-repo');
  });

  it('extractRef(push) returns payload.after', () => {
    expect(normalizer.extractRef('push', push)).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('extractRef(pull_request) returns pull_request.head.sha', () => {
    const pr = loadFixture('forgejo-pull_request.json');
    expect(normalizer.extractRef('pull_request', pr)).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('extractDefaultBranch returns repository.default_branch', () => {
    expect(normalizer.extractDefaultBranch(push)).toBe('main');
  });

  it('extractCredentials returns empty record', () => {
    expect(normalizer.extractCredentials(push)).toEqual({});
  });
});

describe('UniversalGitWebhookNormalizer — gitlab-repo preset', () => {
  const normalizer = new UniversalGitWebhookNormalizer({
    routingKey: 'generic:org:gitlab',
    config: baseConfig({
      preset: 'gitlab-repo',
      gitUrlTemplate: 'https://gitlab.example.com/{repo}.git',
    }),
  });
  const push = loadFixture('gitlab-repo-push.json');

  it('extractRepoIdentifier reads project.path_with_namespace', () => {
    expect(normalizer.extractRepoIdentifier(push)).toBe('group/subgroup/svc');
  });

  it('normalizeEvent maps "Push Hook" header value to push', () => {
    const ev = normalizer.normalizeEvent('Push Hook', null, push);
    expect(ev!.type).toBe('push');
    expect(ev!.targetBranch).toBe('main');
    expect(ev!.senderUsername).toBe('gitlab-user');
  });

  it('extractDefaultBranch reads project.default_branch', () => {
    expect(normalizer.extractDefaultBranch(push)).toBe('main');
  });
});

describe('UniversalGitWebhookNormalizer — gitea + gogs + github presets', () => {
  it('gitea: initial push (zero before SHA) still normalizes', () => {
    const normalizer = new UniversalGitWebhookNormalizer({
      routingKey: 'generic:org:gitea',
      config: baseConfig({ preset: 'gitea' }),
    });
    const push = loadFixture('gitea-push.json');
    const ev = normalizer.normalizeEvent('push', null, push);
    expect(ev!.type).toBe('push');
    expect(ev!.targetBranch).toBe('master');
  });

  it('gogs: extractRef returns payload.after', () => {
    const normalizer = new UniversalGitWebhookNormalizer({
      routingKey: 'generic:org:gogs',
      config: baseConfig({ preset: 'gogs' }),
    });
    const push = loadFixture('gogs-push.json');
    expect(normalizer.extractRef('push', push)).toBe('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
  });

  it('github-repo: targetBranch still derived from refs/heads/', () => {
    const normalizer = new UniversalGitWebhookNormalizer({
      routingKey: 'generic:org:gh',
      config: baseConfig({ preset: 'github-repo' }),
    });
    const push = loadFixture('github-repo-push.json');
    const ev = normalizer.normalizeEvent('push', null, push);
    expect(ev!.targetBranch).toBe('main');
  });
});

describe('universal-git commit message extraction', () => {
  const makeNormalizer = (preset: UniversalGitConfig['preset']) =>
    new UniversalGitWebhookNormalizer({
      routingKey: 'generic:org:src',
      config: baseConfig({ preset }),
    });

  it('reads head_commit.message on a gitea-preset push', () => {
    const n = makeNormalizer('gitea');
    const event = n.normalizeEvent('push', null, {
      ref: 'refs/heads/main',
      after: 'sha1',
      repository: { full_name: 'o/r', default_branch: 'main' },
      head_commit: { message: 'feat: thing\n\n[skip ci]\n' },
      commits: [{ message: 'older' }, { message: 'feat: thing\n\n[skip ci]\n' }],
    });
    expect(event?.commitMessage).toBe('feat: thing\n\n[skip ci]\n');
  });

  it('falls back to the LAST commits[] entry on a gogs-preset push (no head_commit)', () => {
    const n = makeNormalizer('gogs');
    const event = n.normalizeEvent('push', null, {
      ref: 'refs/heads/main',
      after: 'sha1',
      repository: { full_name: 'o/r', default_branch: 'main' },
      commits: [{ message: 'first' }, { message: 'second (head)' }],
    });
    expect(event?.commitMessage).toBe('second (head)');
  });

  it('is undefined when the configured path resolves to nothing', () => {
    const n = makeNormalizer('gogs');
    const event = n.normalizeEvent('push', null, {
      ref: 'refs/heads/main',
      after: 'sha1',
      repository: { full_name: 'o/r', default_branch: 'main' },
      commits: [],
    });
    expect(event?.commitMessage).toBeUndefined();
  });

  it('joins title and body structurally for a PR, accepting the GitLab spelling', () => {
    const gitea = makeNormalizer('gitea');
    expect(
      gitea.normalizeEvent('pull_request', 'opened', {
        repository: { full_name: 'o/r', default_branch: 'main' },
        pull_request: {
          title: 'Add deploy',
          body: 'closes #4',
          base: { ref: 'main' },
          head: { ref: 'f' },
        },
      })?.commitMessage,
    ).toBe('Add deploy\ncloses #4');

    const gitlab = makeNormalizer('gitlab-repo');
    expect(
      gitlab.normalizeEvent('Merge Request Hook', null, {
        project: { path_with_namespace: 'o/r', default_branch: 'main' },
        object_attributes: {
          title: 'MR',
          description: 'desc',
          target_branch: 'main',
          source_branch: 'f',
        },
      })?.commitMessage,
    ).toBe('MR\ndesc');
  });

  it('normalizes (does not throw) a PR event whose object_attributes is null', () => {
    const gitlab = makeNormalizer('gitlab-repo');
    let event: ReturnType<typeof gitlab.normalizeEvent>;
    expect(() => {
      event = gitlab.normalizeEvent('Merge Request Hook', null, {
        project: { path_with_namespace: 'o/r', default_branch: 'main' },
        object_attributes: null,
      });
    }).not.toThrow();
    expect(event!.type).toBe('pull_request');
    expect(event!.commitMessage).toBeUndefined();
  });
});
