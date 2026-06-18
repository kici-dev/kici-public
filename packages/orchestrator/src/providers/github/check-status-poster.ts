/**
 * GitHub implementation of the CheckStatusPoster interface.
 *
 * Posts check statuses to GitHub PRs using the Checks API for:
 * - Security holds (pending): "KiCI Security: Held for approval"
 * - Workflow modifications (neutral): "KiCI: Workflow changes detected"
 * - Approved runs (success) / Rejected/expired runs (failure)
 *
 * Reuses the Octokit infrastructure from auth.ts via createInstallationOctokit.
 * Uses a fixed check name per category so that subsequent updates (approve/reject)
 * can find and update the existing check run.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { CheckStatusPoster, CheckStatus } from '@kici-dev/engine';
import type { Octokit } from '@octokit/rest';
import type { WorkflowModification } from '../../security/workflow-diff.js';

const logger = createLogger({ prefix: 'github-check-poster' });

/** Check run name for security-related statuses. */
const SECURITY_CHECK_NAME = 'KiCI Security';

/** Check run name for workflow modification informational checks. */
const WORKFLOW_CHANGES_CHECK_NAME = 'KiCI: Workflow changes';

/** Map CheckStatus to GitHub Checks API conclusion. */
function mapConclusion(status: CheckStatus): 'success' | 'failure' | 'neutral' {
  switch (status) {
    case 'success':
      return 'success';
    case 'failure':
      return 'failure';
    case 'neutral':
      return 'neutral';
    case 'pending':
      // pending has no conclusion (in_progress status)
      throw new Error('pending status has no conclusion');
  }
}

/**
 * GitHub CheckStatusPoster using the Checks API.
 *
 * Creates or updates check runs for security events. The check name
 * is fixed so that updates (approve/reject) modify the same check.
 */
export class GitHubCheckStatusPoster implements CheckStatusPoster {
  readonly provider = 'github' as const;

  constructor(private readonly getOctokit: (credentials: unknown) => Octokit) {}

  async postCheckStatus(
    repoIdentifier: string,
    commitSha: string,
    status: CheckStatus,
    title: string,
    summary: string,
    credentials: unknown,
  ): Promise<void> {
    const octokit = this.getOctokit(credentials);
    const [owner, repo] = repoIdentifier.split('/');

    try {
      // Try to find existing check run with the same name on this commit
      const { data: existingChecks } = await octokit.checks.listForRef({
        owner,
        repo,
        ref: commitSha,
        check_name: SECURITY_CHECK_NAME,
      });

      if (existingChecks.check_runs.length > 0) {
        // Update existing check run
        await octokit.checks.update({
          owner,
          repo,
          check_run_id: existingChecks.check_runs[0].id,
          status: status === 'pending' ? 'in_progress' : 'completed',
          ...(status !== 'pending' && { conclusion: mapConclusion(status) }),
          ...(status !== 'pending' && { completed_at: new Date().toISOString() }),
          output: { title, summary },
        });
      } else {
        // Create new check run
        await octokit.checks.create({
          owner,
          repo,
          name: SECURITY_CHECK_NAME,
          head_sha: commitSha,
          status: status === 'pending' ? 'in_progress' : 'completed',
          ...(status !== 'pending' && { conclusion: mapConclusion(status) }),
          ...(status !== 'pending' && { completed_at: new Date().toISOString() }),
          output: { title, summary },
        });
      }
    } catch (err) {
      logger.error('Failed to post check status', {
        repoIdentifier,
        commitSha,
        status,
        title,
        error: toErrorMessage(err),
      });
      throw err;
    }
  }

  /**
   * Post an informational check for workflow modifications detected in a PR.
   *
   * Uses a separate check name ("KiCI: Workflow changes") so it doesn't
   * conflict with the security hold check. Always posted as neutral/completed.
   */
  async postWorkflowModificationCheck(
    repoIdentifier: string,
    commitSha: string,
    modifications: WorkflowModification[],
    credentials: unknown,
  ): Promise<void> {
    const octokit = this.getOctokit(credentials);
    const [owner, repo] = repoIdentifier.split('/');

    // Build summary listing the modifications
    const lines = modifications.map((m) => `- **${m.changeType}**: \`${m.workflowName}\``);
    const summary = [
      'This PR adds/modifies workflows -- changes will take effect after merge.',
      '',
      '### Detected changes',
      ...lines,
    ].join('\n');

    try {
      await octokit.checks.create({
        owner,
        repo,
        name: WORKFLOW_CHANGES_CHECK_NAME,
        head_sha: commitSha,
        status: 'completed',
        conclusion: 'neutral',
        completed_at: new Date().toISOString(),
        output: {
          title: 'Workflow changes detected',
          summary,
        },
      });
    } catch (err) {
      logger.error('Failed to post workflow modification check', {
        repoIdentifier,
        commitSha,
        modificationCount: modifications.length,
        error: toErrorMessage(err),
      });
      throw err;
    }
  }
}
