/**
 * Posts approval/hold status checks on PRs for the CI security system, making
 * trust-tier gating decisions visible.
 */
import type { CheckRunConclusion } from './check-run-conclusion.js';
import type { ProviderType } from './types.js';

/**
 * Status values for a check run: still running, or one of the terminal
 * conclusions.
 *
 * The terminal half is `CheckRunConclusion`, shared with the workflow and
 * per-job `kici/…` check runs, plus `neutral`, which only the informational
 * security checks use. So an ending hold reports the same on the security check
 * and the `kici/…` checks of the same event: `cancelled` for a rejection,
 * `timed_out` for an elapsed approval window.
 */
export type CheckStatus = 'pending' | 'neutral' | CheckRunConclusion;

/** A single workflow-file change detected between base and head lock files. */
export interface WorkflowModificationInfo {
  changeType: string;
  workflowName: string;
}

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
   * Post a failing check recording that the pre-run evaluation of the
   * organization's global workflows could not be completed, so none of the
   * workflows it was deciding on ran for this commit.
   *
   * Its own check name: the security-hold check is a single named run per
   * commit, so posting this through `postCheckStatus` would UPDATE that run and
   * replace a pending "Held for approval" state with a completed conclusion.
   *
   * Optional so a provider bundle with no notion of commit checks (or a
   * hand-built one) is silent rather than failing the delivery.
   */
  postGlobalEvalFailedCheck?(
    repoIdentifier: string,
    commitSha: string,
    summary: string,
    credentials: unknown,
  ): Promise<void>;
  /**
   * Post the success conclusion on the organization-workflow-evaluation check —
   * the same check name {@link postGlobalEvalFailedCheck} writes — after a
   * re-run of the failed round completes cleanly, so a bot gating on all-green
   * is unblocked without a new commit.
   *
   * Optional, like the failure poster: a bundle with no notion of commit checks
   * is silent rather than failing the re-run.
   */
  postGlobalEvalSucceededCheck?(
    repoIdentifier: string,
    commitSha: string,
    summary: string,
    credentials: unknown,
  ): Promise<void>;
}
