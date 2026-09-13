import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  EventPayload,
  PullRequestEventPayload,
  PushEventPayload,
  TagEventPayload,
  CommentEventPayload,
  ScheduleEventPayload,
  GitHubPullRequest,
} from './event-payloads.js';
import { isEventType } from './event-payloads.js';

describe('EventPayload discriminated union', () => {
  describe('type narrowing', () => {
    it('narrows pull_request events to PullRequestEventPayload', () => {
      const event: EventPayload = {
        type: 'pull_request',
        action: 'opened',
        targetBranch: 'main',
        sourceBranch: 'feature',
        provider: 'github',
        payload: {
          action: 'opened',
          number: 42,
          pull_request: {
            number: 42,
            draft: false,
            head: { ref: 'feature', sha: 'abc123' },
            base: { ref: 'main' },
          },
          repository: { full_name: 'owner/repo', default_branch: 'main' },
          sender: { login: 'alice' },
        },
      };

      if (event.type === 'pull_request') {
        // After narrowing, these should be typed (not unknown)
        expectTypeOf(event).toEqualTypeOf<PullRequestEventPayload>();
        expect(event.payload.pull_request.number).toBe(42);
        expect(event.payload.pull_request.draft).toBe(false);
        expect(event.payload.pull_request.head.ref).toBe('feature');
        expect(event.payload.pull_request.head.sha).toBe('abc123');
        expect(event.payload.repository.full_name).toBe('owner/repo');
        expect(event.payload.sender.login).toBe('alice');
      }
    });

    it('narrows push events to PushEventPayload', () => {
      const event: EventPayload = {
        type: 'push',
        targetBranch: 'main',
        provider: 'github',
        payload: {
          ref: 'refs/heads/main',
          after: 'abc123',
          before: 'def456',
          head_commit: { id: 'abc123', message: 'fix: something' },
          repository: { full_name: 'owner/repo', default_branch: 'main' },
        },
      };

      if (event.type === 'push') {
        expectTypeOf(event).toEqualTypeOf<PushEventPayload>();
        expect(event.payload.ref).toBe('refs/heads/main');
        expect(event.payload.after).toBe('abc123');
        expect(event.payload.head_commit?.message).toBe('fix: something');
      }
    });

    it('narrows tag events to TagEventPayload', () => {
      const event: EventPayload = {
        type: 'tag',
        targetBranch: 'v1.0.0',
        payload: {
          ref: 'refs/tags/v1.0.0',
          after: 'abc123',
          repository: { full_name: 'owner/repo', default_branch: 'main' },
        },
      };

      if (event.type === 'tag') {
        expectTypeOf(event).toEqualTypeOf<TagEventPayload>();
        expect(event.payload.ref).toBe('refs/tags/v1.0.0');
      }
    });

    it('narrows comment events to CommentEventPayload', () => {
      const event: EventPayload = {
        type: 'comment',
        action: 'created',
        payload: {
          action: 'created',
          comment: { id: 1, body: 'LGTM', user: { login: 'bob' } },
          repository: { full_name: 'owner/repo', default_branch: 'main' },
          sender: { login: 'bob' },
        },
      };

      if (event.type === 'comment') {
        expectTypeOf(event).toEqualTypeOf<CommentEventPayload>();
        expect(event.payload.comment.body).toBe('LGTM');
        expect(event.payload.comment.user.login).toBe('bob');
      }
    });
  });

  describe('isEventType helper', () => {
    it('returns true and narrows type for matching events', () => {
      const event: EventPayload = {
        type: 'pull_request',
        action: 'opened',
        payload: {
          action: 'opened',
          number: 1,
          pull_request: {
            number: 1,
            head: { ref: 'feat', sha: 'aaa' },
            base: { ref: 'main' },
          },
          repository: { full_name: 'o/r', default_branch: 'main' },
          sender: { login: 'x' },
        },
      };

      expect(isEventType(event, 'pull_request')).toBe(true);
      if (isEventType(event, 'pull_request')) {
        expectTypeOf(event).toEqualTypeOf<PullRequestEventPayload>();
        expect(event.payload.pull_request.head.sha).toBe('aaa');
      }
    });

    it('returns false for non-matching events', () => {
      const event: EventPayload = {
        type: 'push',
        payload: {
          ref: 'refs/heads/main',
          after: 'abc',
          before: 'def',
          repository: { full_name: 'o/r', default_branch: 'main' },
        },
      };

      expect(isEventType(event, 'pull_request')).toBe(false);
      expect(isEventType(event, 'push')).toBe(true);
    });

    it('works with generic event types', () => {
      const event: EventPayload = {
        type: 'schedule',
        payload: { cron: '0 * * * *' },
      };

      expect(isEventType(event, 'schedule')).toBe(true);
      if (isEventType(event, 'schedule')) {
        expectTypeOf(event).toEqualTypeOf<ScheduleEventPayload>();
      }
    });
  });

  describe('backward compatibility', () => {
    it('allows accessing untyped properties via index signature', () => {
      const event: EventPayload = {
        type: 'push',
        payload: {
          ref: 'refs/heads/main',
          after: 'abc',
          before: 'def',
          repository: { full_name: 'o/r', default_branch: 'main' },
        },
        // Extra property — allowed by index signature
        customField: 'hello',
      };

      // Index signature allows unknown property access (resolves to unknown)
      expect(event.customField).toBe('hello');
    });

    it('accepts Record<string, unknown> cast (agent compatibility)', () => {
      // Agent code casts Record<string, unknown> to EventPayload
      const raw: Record<string, unknown> = {
        type: 'push',
        payload: { ref: 'refs/heads/main' },
      };

      const event = raw as EventPayload;
      expect(event.type).toBe('push');
    });

    it('accepts empty object cast (agent fallback)', () => {
      // Agent uses `request.event ?? {}` — the empty object case
      const raw: Record<string, unknown> = {};
      const event = raw as EventPayload;
      expectTypeOf(event).toEqualTypeOf<EventPayload>();
    });
  });

  describe('GitHub sub-types', () => {
    it('GitHubPullRequest has expected fields', () => {
      const pr: GitHubPullRequest = {
        number: 42,
        draft: true,
        title: 'Add feature',
        head: { ref: 'feature', sha: 'abc123' },
        base: { ref: 'main' },
      };

      expect(pr.number).toBe(42);
      expect(pr.draft).toBe(true);
      expect(pr.head.ref).toBe('feature');
      expect(pr.head.sha).toBe('abc123');
      expect(pr.base.ref).toBe('main');
    });
  });
});
