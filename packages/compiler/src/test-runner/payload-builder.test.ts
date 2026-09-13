import { describe, it, expect, vi } from 'vitest';
import { buildEventPayload } from './payload-builder.js';

// Mock git-detector to avoid filesystem access
vi.mock('./git-detector.js', () => ({
  detectRepoFromGit: vi.fn().mockResolvedValue({ owner: 'test-org', name: 'test-repo' }),
}));

describe('buildEventPayload', () => {
  describe('--pr override for review events', () => {
    it('applies --pr to review events', async () => {
      const result = await buildEventPayload('review:submitted', { pr: 42 });
      expect(result.type).toBe('review');
      const payload = result.payload as Record<string, unknown>;
      expect(payload.number).toBe(42);
      expect((payload.pull_request as Record<string, unknown>).number).toBe(42);
    });

    it('applies --pr to review_comment events', async () => {
      const result = await buildEventPayload('review_comment:created', { pr: 7 });
      expect(result.type).toBe('review_comment');
      const payload = result.payload as Record<string, unknown>;
      expect(payload.number).toBe(7);
      expect((payload.pull_request as Record<string, unknown>).number).toBe(7);
    });

    it('applies --pr to pull_request events', async () => {
      const result = await buildEventPayload('pr:open', { pr: 99 });
      expect(result.type).toBe('pull_request');
      const payload = result.payload as Record<string, unknown>;
      expect(payload.number).toBe(99);
      expect((payload.pull_request as Record<string, unknown>).number).toBe(99);
    });
  });

  describe('create/delete ref_type override', () => {
    it('sets ref_type to "tag" for create:tag event', async () => {
      const result = await buildEventPayload('create:tag', {});
      expect(result.type).toBe('create');
      expect((result.payload as Record<string, unknown>).ref_type).toBe('tag');
    });

    it('sets ref_type to "branch" for create:branch event', async () => {
      const result = await buildEventPayload('create:branch', {});
      expect(result.type).toBe('create');
      expect((result.payload as Record<string, unknown>).ref_type).toBe('branch');
    });

    it('sets ref_type to "tag" for delete:tag event', async () => {
      const result = await buildEventPayload('delete:tag', {});
      expect(result.type).toBe('delete');
      expect((result.payload as Record<string, unknown>).ref_type).toBe('tag');
    });

    it('sets ref_type to "branch" for delete:branch event', async () => {
      const result = await buildEventPayload('delete:branch', {});
      expect(result.type).toBe('delete');
      expect((result.payload as Record<string, unknown>).ref_type).toBe('branch');
    });

    it('preserves original ref_type for bare create event', async () => {
      const result = await buildEventPayload('create', {});
      // Default fixture has ref_type: "branch" — bare create should not override
      expect((result.payload as Record<string, unknown>).ref_type).toBe('branch');
    });
  });

  describe('--files option', () => {
    it('populates changedFiles from files option', async () => {
      const result = await buildEventPayload('push', {
        files: ['src/index.ts', 'README.md'],
      });
      expect(result.changedFiles).toEqual(['src/index.ts', 'README.md']);
    });

    it('defaults changedFiles to empty array when no files option', async () => {
      const result = await buildEventPayload('push', {});
      expect(result.changedFiles).toEqual([]);
    });

    it('populates changedFiles for internal event types', async () => {
      const result = await buildEventPayload('schedule', {
        files: ['cron/job.ts'],
      });
      expect(result.changedFiles).toEqual(['cron/job.ts']);
    });
  });
});
