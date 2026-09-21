import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { GitHubWebhookNormalizer } from './normalizer.js';

// -- Helpers --

function computeSignature(body: string, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(body, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

// -- Tests --

describe('GitHubWebhookNormalizer', () => {
  const normalizer = new GitHubWebhookNormalizer();

  it('has provider set to github', () => {
    expect(normalizer.provider).toBe('github');
  });

  // fails-when: the access-cache invalidation hook returns to the normalizer
  it('has no access-cache invalidation hook', () => {
    expect('getAccessCacheInvalidations' in normalizer).toBe(false);
  });

  // breaks-if-wrong: the surviving normalizer methods must still be there
  it('keeps the live normalizer methods', () => {
    expect(typeof normalizer.normalizeEvent).toBe('function');
    expect(typeof normalizer.verifySignature).toBe('function');
  });

  describe('extractRoutingKey', () => {
    it('returns github:{id} from x-github-hook-installation-target-id header', () => {
      const headers = { 'x-github-hook-installation-target-id': '12345' };
      expect(normalizer.extractRoutingKey(headers, {})).toBe('github:12345');
    });

    it('returns null when header is missing', () => {
      const headers = { 'x-github-event': 'push' };
      expect(normalizer.extractRoutingKey(headers, {})).toBeNull();
    });
  });

  describe('extractDeliveryId', () => {
    it('extracts from x-github-delivery header', () => {
      const headers = { 'x-github-delivery': 'abc-123-def' };
      expect(normalizer.extractDeliveryId(headers)).toBe('abc-123-def');
    });

    it('returns null when header is missing', () => {
      expect(normalizer.extractDeliveryId({})).toBeNull();
    });
  });

  describe('extractEventType', () => {
    it('extracts from x-github-event header', () => {
      const headers = { 'x-github-event': 'pull_request' };
      expect(normalizer.extractEventType(headers)).toBe('pull_request');
    });

    it('returns null when header is missing', () => {
      expect(normalizer.extractEventType({})).toBeNull();
    });
  });

  describe('verifySignature', () => {
    const secret = 'webhook-secret-123';
    const body = '{"action":"opened","number":1}';

    it('returns true for valid signature', () => {
      const signature = computeSignature(body, secret);
      const headers = { 'x-hub-signature-256': signature };
      expect(normalizer.verifySignature(body, headers, secret)).toBe(true);
    });

    it('returns false for invalid signature', () => {
      const headers = {
        'x-hub-signature-256':
          'sha256=invalid0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      };
      expect(normalizer.verifySignature(body, headers, secret)).toBe(false);
    });

    it('returns false when signature header is missing', () => {
      expect(normalizer.verifySignature(body, {}, secret)).toBe(false);
    });

    it('returns false when wrong secret is used', () => {
      const signature = computeSignature(body, 'wrong-secret');
      const headers = { 'x-hub-signature-256': signature };
      expect(normalizer.verifySignature(body, headers, secret)).toBe(false);
    });
  });

  describe('normalizeEvent', () => {
    it('normalizes pull_request event with action', () => {
      const payload = {
        pull_request: {
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          head: { ref: 'feature/auth', repo: { full_name: 'owner/repo' } },
        },
        sender: { login: 'contributor', id: 267095011 },
      };

      const result = normalizer.normalizeEvent('pull_request', 'opened', payload);

      expect(result).toMatchObject({
        type: 'pull_request',
        action: 'opened',
        targetBranch: 'main',
        sourceBranch: 'feature/auth',
        baseBranch: 'main',
        isForkPR: false,
        senderUsername: 'contributor',
        senderUserId: '267095011',
        provider: 'github',
      });
    });

    it('captures senderUserId on push events as a coerced string', () => {
      const payload = {
        ref: 'refs/heads/master',
        sender: { login: 'pusher', id: 42 },
      };
      const result = normalizer.normalizeEvent('push', null, payload);
      expect(result).toMatchObject({
        type: 'push',
        senderUsername: 'pusher',
        senderUserId: '42',
      });
    });

    it('omits senderUserId when sender.id is missing', () => {
      const payload = {
        pull_request: {
          base: { ref: 'main' },
          head: { ref: 'feat' },
        },
        sender: { login: 'contributor' },
      };
      const result = normalizer.normalizeEvent('pull_request', 'opened', payload);
      expect(result?.senderUsername).toBe('contributor');
      expect(result?.senderUserId).toBeUndefined();
    });

    it('sets prNumber for pull_request events', () => {
      const result = normalizer.normalizeEvent('pull_request', 'opened', {
        pull_request: { number: 42, base: { ref: 'main' }, head: { ref: 'feature' } },
        sender: { login: 'alice', id: 1 },
      });
      expect(result?.prNumber).toBe(42);
    });

    it('sets prNumber for pull_request_review events', () => {
      const result = normalizer.normalizeEvent('pull_request_review', 'submitted', {
        pull_request: { number: 7, base: { ref: 'main' }, head: { ref: 'feat' } },
        sender: { login: 'bob', id: 2 },
      });
      expect(result?.prNumber).toBe(7);
    });

    it('sets prNumber for pull_request_review_comment events', () => {
      const result = normalizer.normalizeEvent('pull_request_review_comment', 'created', {
        pull_request: { number: 9, base: { ref: 'main' }, head: { ref: 'feat' } },
        sender: { login: 'carol', id: 3 },
      });
      expect(result?.prNumber).toBe(9);
    });

    it('leaves prNumber undefined for push events', () => {
      const result = normalizer.normalizeEvent('push', null, {
        ref: 'refs/heads/main',
        sender: { login: 'dave', id: 4 },
      });
      expect(result?.prNumber).toBeUndefined();
    });

    it('leaves prNumber undefined when pull_request has no number', () => {
      const result = normalizer.normalizeEvent('pull_request', 'opened', {
        pull_request: { base: { ref: 'main' }, head: { ref: 'feat' } },
        sender: { login: 'eve', id: 5 },
      });
      expect(result?.prNumber).toBeUndefined();
    });

    it('normalizes pull_request without source branch', () => {
      const payload = {
        pull_request: {
          base: { ref: 'develop' },
        },
      };

      const result = normalizer.normalizeEvent('pull_request', 'closed', payload);

      expect(result).not.toBeNull();
      expect(result!.targetBranch).toBe('develop');
      expect(result!.sourceBranch).toBeUndefined();
      expect(result!.action).toBe('closed');
      expect(result!.baseBranch).toBe('develop');
    });

    it('returns null for pull_request without target branch', () => {
      const payload = { pull_request: {} };
      expect(normalizer.normalizeEvent('pull_request', 'opened', payload)).toBeNull();
    });

    it('returns null for pull_request without pull_request data', () => {
      const payload = { ref: 'refs/heads/main' };
      expect(normalizer.normalizeEvent('pull_request', 'opened', payload)).toBeNull();
    });

    it('normalizes push event and strips refs/heads/ prefix', () => {
      const payload = { ref: 'refs/heads/main' };

      const result = normalizer.normalizeEvent('push', null, payload);

      expect(result).toMatchObject({
        type: 'push',
        targetBranch: 'main',
        provider: 'github',
      });
    });

    it('normalizes push event with tag ref as type: tag', () => {
      const payload = { ref: 'refs/tags/v1.0.0' };

      const result = normalizer.normalizeEvent('push', null, payload);

      expect(result).toMatchObject({
        type: 'tag',
        targetBranch: 'v1.0.0',
        provider: 'github',
      });
    });

    it('normalizes push event with tag ref strips refs/tags/ prefix', () => {
      const payload = { ref: 'refs/tags/release/2.0' };

      const result = normalizer.normalizeEvent('push', null, payload);

      expect(result).not.toBeNull();
      expect(result!.type).toBe('tag');
      expect(result!.targetBranch).toBe('release/2.0');
    });

    it('returns null for push without ref', () => {
      const payload = {};
      expect(normalizer.normalizeEvent('push', null, payload)).toBeNull();
    });

    it('returns null for unknown event type', () => {
      const payload = { action: 'created' };
      expect(normalizer.normalizeEvent('unknown_event', null, payload)).toBeNull();
    });

    it('returns null for issues event (not in supported list)', () => {
      const payload = { action: 'opened', issue: { number: 1 } };
      expect(normalizer.normalizeEvent('issues', 'opened', payload)).toBeNull();
    });

    it('sets provider to github on all returned events', () => {
      const pushResult = normalizer.normalizeEvent('push', null, {
        ref: 'refs/heads/main',
      });
      const prResult = normalizer.normalizeEvent('pull_request', 'opened', {
        pull_request: { base: { ref: 'main' }, head: { ref: 'feat' } },
      });

      expect(pushResult!.provider).toBe('github');
      expect(prResult!.provider).toBe('github');
    });

    it('extracts senderUsername from sender.login', () => {
      const payload = {
        ref: 'refs/heads/main',
        sender: { login: 'testuser' },
      };

      const result = normalizer.normalizeEvent('push', null, payload);

      expect(result).not.toBeNull();
      expect(result!.senderUsername).toBe('testuser');
    });

    it('senderUsername is undefined when no sender in payload', () => {
      const payload = { ref: 'refs/heads/main' };

      const result = normalizer.normalizeEvent('push', null, payload);

      expect(result).not.toBeNull();
      expect(result!.senderUsername).toBeUndefined();
    });
  });

  describe('normalizeEvent - fork PR detection', () => {
    it('detects fork PR when head and base repo differ', () => {
      const payload = {
        pull_request: {
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          head: { ref: 'feature/fix', repo: { full_name: 'forker/repo' } },
        },
        sender: { login: 'forker' },
      };

      const result = normalizer.normalizeEvent('pull_request', 'opened', payload);

      expect(result).not.toBeNull();
      expect(result!.isForkPR).toBe(true);
      expect(result!.senderUsername).toBe('forker');
      expect(result!.baseBranch).toBe('main');
    });

    it('detects same-repo PR when head and base repo match', () => {
      const payload = {
        pull_request: {
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          head: { ref: 'feature/auth', repo: { full_name: 'owner/repo' } },
        },
        sender: { login: 'contributor' },
      };

      const result = normalizer.normalizeEvent('pull_request', 'opened', payload);

      expect(result).not.toBeNull();
      expect(result!.isForkPR).toBe(false);
      expect(result!.senderUsername).toBe('contributor');
    });

    it('isForkPR is false when head repo info is missing', () => {
      const payload = {
        pull_request: {
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          head: { ref: 'feature' },
        },
      };

      const result = normalizer.normalizeEvent('pull_request', 'opened', payload);

      expect(result).not.toBeNull();
      expect(result!.isForkPR).toBe(false);
    });

    it('extracts baseBranch from base ref', () => {
      const payload = {
        pull_request: {
          base: { ref: 'develop', repo: { full_name: 'owner/repo' } },
          head: { ref: 'feature/test', repo: { full_name: 'owner/repo' } },
        },
      };

      const result = normalizer.normalizeEvent('pull_request', 'opened', payload);

      expect(result).not.toBeNull();
      expect(result!.baseBranch).toBe('develop');
    });

    it('detects fork in pull_request_review events', () => {
      const payload = {
        pull_request: {
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          head: { ref: 'fix', repo: { full_name: 'forker/repo' } },
        },
        sender: { login: 'reviewer' },
      };

      const result = normalizer.normalizeEvent('pull_request_review', 'submitted', payload);

      expect(result).not.toBeNull();
      expect(result!.isForkPR).toBe(true);
      expect(result!.baseBranch).toBe('main');
      expect(result!.senderUsername).toBe('reviewer');
    });

    it('detects fork in pull_request_review_comment events', () => {
      const payload = {
        pull_request: {
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          head: { ref: 'fix', repo: { full_name: 'forker/repo' } },
        },
        sender: { login: 'commenter' },
      };

      const result = normalizer.normalizeEvent('pull_request_review_comment', 'created', payload);

      expect(result).not.toBeNull();
      expect(result!.isForkPR).toBe(true);
      expect(result!.baseBranch).toBe('main');
      expect(result!.senderUsername).toBe('commenter');
    });
  });

  describe('normalizeEvent - issue_comment', () => {
    it('returns type: comment with action', () => {
      const payload = {
        action: 'created',
        comment: { body: 'hello' },
        repository: { default_branch: 'main' },
      };

      const result = normalizer.normalizeEvent('issue_comment', 'created', payload);

      expect(result).toMatchObject({
        type: 'comment',
        action: 'created',
        targetBranch: 'main',
        provider: 'github',
      });
    });

    it('uses repository.default_branch for targetBranch', () => {
      const payload = {
        repository: { default_branch: 'develop' },
      };

      const result = normalizer.normalizeEvent('issue_comment', 'created', payload);

      expect(result).not.toBeNull();
      expect(result!.targetBranch).toBe('develop');
    });

    it('falls back to main when repository.default_branch is missing', () => {
      const payload = {};

      const result = normalizer.normalizeEvent('issue_comment', 'created', payload);

      expect(result).not.toBeNull();
      expect(result!.targetBranch).toBe('main');
    });
  });

  describe('normalizeEvent - pull_request_review', () => {
    it('returns type: review with branches from PR', () => {
      const payload = {
        pull_request: {
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          head: { ref: 'feature/auth', repo: { full_name: 'owner/repo' } },
        },
        sender: { login: 'reviewer' },
      };

      const result = normalizer.normalizeEvent('pull_request_review', 'submitted', payload);

      expect(result).toMatchObject({
        type: 'review',
        action: 'submitted',
        targetBranch: 'main',
        sourceBranch: 'feature/auth',
        baseBranch: 'main',
        isForkPR: false,
        senderUsername: 'reviewer',
        provider: 'github',
      });
    });

    it('falls back to default branch when PR data is missing', () => {
      const payload = { repository: { default_branch: 'develop' } };

      const result = normalizer.normalizeEvent('pull_request_review', 'submitted', payload);

      expect(result).not.toBeNull();
      expect(result!.targetBranch).toBe('develop');
    });
  });

  describe('normalizeEvent - pull_request_review_comment', () => {
    it('returns type: review_comment with branches from PR', () => {
      const payload = {
        pull_request: {
          base: { ref: 'main', repo: { full_name: 'owner/repo' } },
          head: { ref: 'fix/typo', repo: { full_name: 'owner/repo' } },
        },
        sender: { login: 'commenter' },
      };

      const result = normalizer.normalizeEvent('pull_request_review_comment', 'created', payload);

      expect(result).toMatchObject({
        type: 'review_comment',
        action: 'created',
        targetBranch: 'main',
        sourceBranch: 'fix/typo',
        baseBranch: 'main',
        isForkPR: false,
        senderUsername: 'commenter',
        provider: 'github',
      });
    });
  });

  describe('normalizeEvent - repository_dispatch', () => {
    it('returns type: dispatch with action from payload.action', () => {
      const payload = {
        action: 'deploy',
        repository: { default_branch: 'main' },
      };

      const result = normalizer.normalizeEvent('repository_dispatch', null, payload);

      expect(result).toMatchObject({
        type: 'dispatch',
        action: 'deploy',
        targetBranch: 'main',
        provider: 'github',
      });
    });

    it('uses payload.action for custom event_type', () => {
      const payload = {
        action: 'run-tests',
        repository: { default_branch: 'trunk' },
      };

      const result = normalizer.normalizeEvent('repository_dispatch', null, payload);

      expect(result).not.toBeNull();
      expect(result!.action).toBe('run-tests');
      expect(result!.targetBranch).toBe('trunk');
    });
  });

  describe('normalizeEvent - release', () => {
    it('returns type: release with target_commitish', () => {
      const payload = {
        release: { target_commitish: 'main' },
        repository: { default_branch: 'main' },
      };

      const result = normalizer.normalizeEvent('release', 'published', payload);

      expect(result).toMatchObject({
        type: 'release',
        action: 'published',
        targetBranch: 'main',
        provider: 'github',
      });
    });

    it('falls back to default branch when target_commitish is missing', () => {
      const payload = {
        release: {},
        repository: { default_branch: 'develop' },
      };

      const result = normalizer.normalizeEvent('release', 'created', payload);

      expect(result).not.toBeNull();
      expect(result!.targetBranch).toBe('develop');
    });
  });

  describe('normalizeEvent - create', () => {
    it('returns type: create with ref as targetBranch', () => {
      const payload = { ref: 'feature/new-branch' };

      const result = normalizer.normalizeEvent('create', null, payload);

      expect(result).toMatchObject({
        type: 'create',
        targetBranch: 'feature/new-branch',
        provider: 'github',
      });
    });

    it('falls back to default branch when ref is missing', () => {
      const payload = { repository: { default_branch: 'main' } };

      const result = normalizer.normalizeEvent('create', null, payload);

      expect(result).not.toBeNull();
      expect(result!.targetBranch).toBe('main');
    });
  });

  describe('normalizeEvent - delete', () => {
    it('returns type: delete with ref as targetBranch', () => {
      const payload = { ref: 'feature/old-branch' };

      const result = normalizer.normalizeEvent('delete', null, payload);

      expect(result).toMatchObject({
        type: 'delete',
        targetBranch: 'feature/old-branch',
        provider: 'github',
      });
    });
  });

  describe('normalizeEvent - status', () => {
    it('returns type: status with first branch name', () => {
      const payload = {
        branches: [{ name: 'main' }, { name: 'develop' }],
      };

      const result = normalizer.normalizeEvent('status', null, payload);

      expect(result).toMatchObject({
        type: 'status',
        targetBranch: 'main',
        provider: 'github',
      });
    });

    it('falls back to default branch when branches is empty', () => {
      const payload = {
        branches: [],
        repository: { default_branch: 'develop' },
      };

      const result = normalizer.normalizeEvent('status', null, payload);

      expect(result).not.toBeNull();
      expect(result!.targetBranch).toBe('develop');
    });
  });

  describe('normalizeEvent - workflow_run', () => {
    it('returns type: workflow_run with head_branch', () => {
      const payload = {
        workflow_run: { head_branch: 'main' },
      };

      const result = normalizer.normalizeEvent('workflow_run', 'completed', payload);

      expect(result).toMatchObject({
        type: 'workflow_run',
        action: 'completed',
        targetBranch: 'main',
        provider: 'github',
      });
    });

    it('falls back to default branch when head_branch is missing', () => {
      const payload = {
        workflow_run: {},
        repository: { default_branch: 'trunk' },
      };

      const result = normalizer.normalizeEvent('workflow_run', 'completed', payload);

      expect(result).not.toBeNull();
      expect(result!.targetBranch).toBe('trunk');
    });
  });

  describe('normalizeEvent - fork', () => {
    it('returns type: fork with default branch', () => {
      const payload = {
        repository: { default_branch: 'main' },
      };

      const result = normalizer.normalizeEvent('fork', null, payload);

      expect(result).toMatchObject({
        type: 'fork',
        targetBranch: 'main',
        provider: 'github',
      });
    });

    it('has no action', () => {
      const payload = {};

      const result = normalizer.normalizeEvent('fork', null, payload);

      expect(result).not.toBeNull();
      expect(result!.action).toBeUndefined();
    });
  });

  describe('normalizeEvent - star', () => {
    it('returns type: star with action and default branch', () => {
      const payload = {
        repository: { default_branch: 'main' },
      };

      const result = normalizer.normalizeEvent('star', 'created', payload);

      expect(result).toMatchObject({
        type: 'star',
        action: 'created',
        targetBranch: 'main',
        provider: 'github',
      });
    });
  });

  describe('normalizeEvent - watch', () => {
    it('returns type: watch with action and default branch', () => {
      const payload = {
        repository: { default_branch: 'main' },
      };

      const result = normalizer.normalizeEvent('watch', 'started', payload);

      expect(result).toMatchObject({
        type: 'watch',
        action: 'started',
        targetBranch: 'main',
        provider: 'github',
      });
    });
  });

  describe('extractRepoIdentifier', () => {
    it('extracts from repository.full_name', () => {
      const payload = { repository: { full_name: 'octocat/Hello-World' } };
      expect(normalizer.extractRepoIdentifier(payload)).toBe('octocat/Hello-World');
    });

    it('falls back to owner.login/name when full_name is missing', () => {
      const payload = {
        repository: { owner: { login: 'octocat' }, name: 'Hello-World' },
      };
      expect(normalizer.extractRepoIdentifier(payload)).toBe('octocat/Hello-World');
    });

    it('returns null when repository is missing', () => {
      expect(normalizer.extractRepoIdentifier({})).toBeNull();
    });

    it('returns null when repository has no identifiable fields', () => {
      const payload = { repository: { id: 123 } };
      expect(normalizer.extractRepoIdentifier(payload)).toBeNull();
    });

    it('prefers full_name over owner/name', () => {
      const payload = {
        repository: {
          full_name: 'org/repo-full',
          owner: { login: 'org' },
          name: 'repo-fallback',
        },
      };
      expect(normalizer.extractRepoIdentifier(payload)).toBe('org/repo-full');
    });
  });

  describe('extractRef', () => {
    it('extracts payload.after for push events', () => {
      expect(normalizer.extractRef('push', { after: 'abc123' })).toBe('abc123');
    });

    it('returns HEAD for push without after', () => {
      expect(normalizer.extractRef('push', {})).toBe('HEAD');
    });

    it('extracts pull_request.head.sha for pull_request events', () => {
      const payload = { pull_request: { head: { sha: 'pr-sha-123' } } };
      expect(normalizer.extractRef('pull_request', payload)).toBe('pr-sha-123');
    });

    it('extracts pull_request.head.sha for pull_request_review events', () => {
      const payload = { pull_request: { head: { sha: 'review-sha' } } };
      expect(normalizer.extractRef('pull_request_review', payload)).toBe('review-sha');
    });

    it('extracts pull_request.head.sha for pull_request_review_comment events', () => {
      const payload = { pull_request: { head: { sha: 'comment-sha' } } };
      expect(normalizer.extractRef('pull_request_review_comment', payload)).toBe('comment-sha');
    });

    it('extracts payload.sha for status events', () => {
      expect(normalizer.extractRef('status', { sha: 'status-sha' })).toBe('status-sha');
    });

    it('extracts release.target_commitish for release events', () => {
      const payload = { release: { target_commitish: 'main' } };
      expect(normalizer.extractRef('release', payload)).toBe('main');
    });

    it('returns HEAD for issue_comment events', () => {
      expect(normalizer.extractRef('issue_comment', {})).toBe('HEAD');
    });

    it('returns HEAD for unknown event types', () => {
      expect(normalizer.extractRef('unknown_event', {})).toBe('HEAD');
    });
  });

  describe('extractCredentials', () => {
    it('extracts installationId from payload.installation.id', () => {
      const payload = { installation: { id: 12345 } };
      expect(normalizer.extractCredentials(payload)).toEqual({ installationId: 12345 });
    });

    it('returns null installationId when installation is missing', () => {
      expect(normalizer.extractCredentials({})).toEqual({ installationId: null });
    });

    it('returns null installationId when id is not a number', () => {
      const payload = { installation: { id: 'not-a-number' } };
      expect(normalizer.extractCredentials(payload)).toEqual({ installationId: null });
    });
  });
});
