/**
 * CheckStatusPoster interface for posting check statuses to git providers.
 *
 * Used by the CI security system to post approval/hold status checks
 * on PRs, enabling visibility into trust-tier gating decisions.
 */
import type { ProviderType } from './types.js';

/** Status values for a check run. */
export type CheckStatus = 'pending' | 'success' | 'failure' | 'neutral';

/** A single workflow-file change detected between base and head lock files. */
export interface WorkflowModificationInfo {
  changeType: string;
  workflowName: string;
}

/** Posts check statuses to a git hosting provider. */
export interface CheckStatusPoster {
  readonly provider: ProviderType;
  postCheckStatus(
    repoIdentifier: string,
    commitSha: string,
    status: CheckStatus,
    title: string,
    summary: string,
    credentials: unknown,
  ): Promise<void>;
  /**
   * Post an informational (neutral) check listing workflow-file modifications
   * detected in a PR. Uses a distinct check name from the security-hold check so
   * the two never overwrite each other.
   */
  postWorkflowModificationCheck(
    repoIdentifier: string,
    commitSha: string,
    modifications: WorkflowModificationInfo[],
    credentials: unknown,
  ): Promise<void>;
  /**
   * Post an informational (neutral) check recording that the organization's
   * global workflows were skipped because the org trust policy held or rejected
   * the event.
   *
   * Its own check name, for the same reason as the workflow-modification check:
   * the security-hold check is a single named run per commit, so posting this
   * notice through `postCheckStatus` would UPDATE that run and replace the
   * pending "Held for approval" state with a completed neutral conclusion —
   * unblocking a branch protection rule that requires the security check.
   */
  postGlobalWorkflowsSkippedCheck(
    repoIdentifier: string,
    commitSha: string,
    summary: string,
    credentials: unknown,
  ): Promise<void>;
  /**
   * Post a failing check recording that the pre-run evaluation of the
   * organization's global workflows could not be completed, so none of the
   * workflows it was deciding on ran for this commit.
   *
   * Its own check name, for the same reason as the two notices above: the
   * security-hold check is a single named run per commit, so posting this
   * through `postCheckStatus` would UPDATE that run and replace a pending
   * "Held for approval" state with a completed conclusion.
   *
   * Optional so a provider bundle that has no notion of commit checks — or a
   * hand-built one — is simply silent rather than failing the delivery.
   */
  postGlobalEvalFailedCheck?(
    repoIdentifier: string,
    commitSha: string,
    summary: string,
    credentials: unknown,
  ): Promise<void>;
}
