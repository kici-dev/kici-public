import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubCheckStatusPoster } from './check-status-poster.js';
import type { WorkflowModification } from '../../security/workflow-diff.js';

function createMockOctokit() {
  return {
    checks: {
      create: vi.fn().mockResolvedValue({ data: { id: 1001 } }),
      update: vi.fn().mockResolvedValue({ data: {} }),
      listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
    },
  };
}

describe('GitHubCheckStatusPoster', () => {
  let mockOctokit: ReturnType<typeof createMockOctokit>;
  let poster: GitHubCheckStatusPoster;

  beforeEach(() => {
    mockOctokit = createMockOctokit();
    poster = new GitHubCheckStatusPoster(() => mockOctokit as any);
  });

  describe('postCheckStatus', () => {
    it('creates a new pending check run when no existing check found', async () => {
      await poster.postCheckStatus(
        'owner/repo',
        'abc123',
        'pending',
        'Held for approval',
        'Unknown contributor. Requires approval.',
        { installationId: 42 },
      );

      expect(mockOctokit.checks.listForRef).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        ref: 'abc123',
        check_name: 'KiCI Security',
      });

      expect(mockOctokit.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'owner',
          repo: 'repo',
          name: 'KiCI Security',
          head_sha: 'abc123',
          status: 'in_progress',
          output: {
            title: 'Held for approval',
            summary: 'Unknown contributor. Requires approval.',
          },
        }),
      );

      // pending should not have conclusion or completed_at
      const createCall = mockOctokit.checks.create.mock.calls[0][0];
      expect(createCall.conclusion).toBeUndefined();
      expect(createCall.completed_at).toBeUndefined();
    });

    it('updates existing check run when one is found', async () => {
      mockOctokit.checks.listForRef.mockResolvedValue({
        data: { check_runs: [{ id: 555 }] },
      });

      await poster.postCheckStatus(
        'owner/repo',
        'abc123',
        'success',
        'Approved',
        'Run approved by admin.',
        {},
      );

      expect(mockOctokit.checks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'owner',
          repo: 'repo',
          check_run_id: 555,
          status: 'completed',
          conclusion: 'success',
          output: {
            title: 'Approved',
            summary: 'Run approved by admin.',
          },
        }),
      );

      // Should not have created a new one
      expect(mockOctokit.checks.create).not.toHaveBeenCalled();
    });

    it('maps success conclusion correctly', async () => {
      await poster.postCheckStatus('o/r', 'sha1', 'success', 't', 's', {});

      const createCall = mockOctokit.checks.create.mock.calls[0][0];
      expect(createCall.conclusion).toBe('success');
      expect(createCall.status).toBe('completed');
      expect(createCall.completed_at).toBeDefined();
    });

    it('maps failure conclusion correctly', async () => {
      await poster.postCheckStatus('o/r', 'sha1', 'failure', 't', 's', {});

      const createCall = mockOctokit.checks.create.mock.calls[0][0];
      expect(createCall.conclusion).toBe('failure');
      expect(createCall.status).toBe('completed');
    });

    it('maps neutral conclusion correctly', async () => {
      await poster.postCheckStatus('o/r', 'sha1', 'neutral', 't', 's', {});

      const createCall = mockOctokit.checks.create.mock.calls[0][0];
      expect(createCall.conclusion).toBe('neutral');
      expect(createCall.status).toBe('completed');
    });

    it('throws on API error', async () => {
      mockOctokit.checks.listForRef.mockRejectedValue(new Error('API error'));

      await expect(poster.postCheckStatus('o/r', 'sha1', 'pending', 't', 's', {})).rejects.toThrow(
        'API error',
      );
    });
  });

  describe('postWorkflowModificationCheck', () => {
    it('creates a neutral check with modification summary', async () => {
      const modifications: WorkflowModification[] = [
        { workflowName: 'ci', changeType: 'modified' },
        { workflowName: 'deploy', changeType: 'added' },
      ];

      await poster.postWorkflowModificationCheck('owner/repo', 'abc123', modifications, {});

      expect(mockOctokit.checks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'owner',
          repo: 'repo',
          name: 'KiCI: Workflow changes',
          head_sha: 'abc123',
          status: 'completed',
          conclusion: 'neutral',
          output: {
            title: 'Workflow changes detected',
            summary: expect.stringContaining('adds/modifies workflows'),
          },
        }),
      );

      const summary = mockOctokit.checks.create.mock.calls[0][0].output.summary;
      expect(summary).toContain('**modified**: `ci`');
      expect(summary).toContain('**added**: `deploy`');
    });

    it('includes removed workflows in summary', async () => {
      const modifications: WorkflowModification[] = [
        { workflowName: 'old-workflow', changeType: 'removed' },
      ];

      await poster.postWorkflowModificationCheck('owner/repo', 'sha1', modifications, {});

      const summary = mockOctokit.checks.create.mock.calls[0][0].output.summary;
      expect(summary).toContain('**removed**: `old-workflow`');
    });

    it('throws on API error', async () => {
      mockOctokit.checks.create.mockRejectedValue(new Error('403 Forbidden'));

      await expect(poster.postWorkflowModificationCheck('o/r', 'sha', [], {})).rejects.toThrow(
        '403 Forbidden',
      );
    });
  });
});
