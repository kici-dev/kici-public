/**
 * /kici approve and /kici reject comment command handler.
 *
 * Parses issue_comment webhook bodies for /kici commands and handles
 * approval/rejection of security holds. Verifies commenter identity
 * via the trust policy cache and checks ci_trust:write+ before acting.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Kysely } from 'kysely';
import type { HeldRunStore, ReleaseSignal } from '../contexts/held-runs.js';
import type { Database, HeldRun } from '../db/types.js';
import { HoldScope, TriggerSource } from '@kici-dev/engine';
import { routeRelease } from '../approvals/resume-router.js';
import { findIdentityLink, type IdentityLink, type PermissionLevel } from './identity-link.js';
import {
  settleSecurityCheckForOutcome,
  HoldOutcome,
  type ResolveCheckStatusPoster,
} from '../pipeline/security-hold-check.js';

const logger = createLogger({ prefix: 'comment-handler' });

/** How the terminal security-check summary names this surface. */
const APPROVE_COMMAND = '/kici approve';
const REJECT_COMMAND = '/kici reject';

/**
 * Map a just-approved `held_runs` row to the signal `routeRelease` discriminates
 * on. The two columns are NOT NULL with defaults, so the fallbacks cover only a
 * row read back as a looser type than the column enforces.
 */
function toReleaseSignal(hold: HeldRun): ReleaseSignal {
  return {
    holdId: hold.id,
    runId: hold.run_id,
    jobId: hold.job_id,
    scope: (hold.hold_scope as HoldScope) ?? HoldScope.enum.job,
    stepIndex: hold.step_index ?? null,
    triggerSource: (hold.trigger_source as TriggerSource) ?? TriggerSource.enum.context,
  };
}

/** Parsed /kici command from a comment body. */
interface CommentCommand {
  action: 'approve' | 'reject';
  /** Optional: specific run to approve/reject. */
  runId?: string;
}

/** Parameters for the approval comment handler. */
export interface HandleApprovalCommentParams {
  commentBody: string;
  commenterUsername: string;
  /**
   * Commenter immutable IDP-side numeric id from the webhook event. The only
   * field an identity link is matched on (see `identity-link.findIdentityLink`).
   */
  commenterUserId?: string;
  provider: string;
  repoIdentifier: string;
  prNumber: number;
  orgId: string;
  identityLinks: IdentityLink[];
  orgMemberPermissions: Map<string, PermissionLevel>;
  heldRunStore: HeldRunStore;
  /**
   * Orchestrator database, for resolving each ended hold's own commit and the
   * other holds still pending on it. Optional so a store-less deployment still
   * processes the command.
   */
  db?: Kysely<Database> | undefined;
  /**
   * Resolve the check poster of the provider bundle serving a routing key, so
   * an ended hold's `KiCI Security` check can be terminalized on the commit the
   * hold's own run acted on — which is not necessarily the PR head at comment
   * time, and posting on the head would create a second check run there while
   * leaving the real one pending.
   */
  resolvePoster?: ResolveCheckStatusPoster;
  /**
   * Resume a job whose security hold was just approved, by re-dispatching it.
   *
   * Approving must RUN the gated work, not merely flip the row and post a green
   * check. The signal is routed through the same `routeRelease` the dashboard
   * applier and the stale detector use, so a job-scoped hold lands here and a
   * workflow-scoped one lands on `onWorkflowRelease`. Optional so an
   * orchestrator without the dispatch wiring degrades to flip-and-report rather
   * than failing the comment.
   */
  onJobRelease?: (signal: ReleaseSignal) => Promise<void>;
  /**
   * Resume a workflow-scoped hold that was just approved, by replaying its
   * stored dispatch context. This is the path the org trust policy's PR-wide
   * hold takes: it fires before any job is materialized, so there is no job to
   * re-dispatch.
   */
  onWorkflowRelease?: (signal: ReleaseSignal) => Promise<void>;
  /**
   * Cancel a workflow-scoped hold that was just rejected, dropping its stored
   * dispatch context. Without it a rejected PR-wide hold leaves its run alive in
   * `held` forever and strands the context row that would have replayed it.
   *
   * It also completes the hold's `KiCI Security` check and resolves to whether
   * it actually wrote one, so this handler reports only the holds no write
   * covered — suppression bound to a check being written, not to a delegate
   * resolving.
   */
  onWorkflowReject?: (hold: HeldRun, reason: string) => Promise<boolean>;
}

/** Result of handling a comment. */
interface HandleApprovalResult {
  handled: boolean;
  reason?: string;
}

/**
 * Parse a comment body for /kici commands.
 *
 * Looks for `/kici approve` or `/kici reject` at the start of any line.
 * Case-insensitive for the command word (approve/reject) but the /kici prefix is exact.
 * Optional run ID follows the command.
 *
 * @returns Parsed command or null if no /kici command found.
 */
export function parseKiciCommand(commentBody: string): CommentCommand | null {
  const lines = commentBody.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^\/kici\s+(approve|reject)(?:\s+(\S+))?/i);
    if (match) {
      return {
        action: match[1].toLowerCase() as 'approve' | 'reject',
        ...(match[2] && { runId: match[2] }),
      };
    }
  }

  return null;
}

/**
 * Handle an approval comment from a PR.
 *
 * Flow:
 * 1. Parse comment for /kici command
 * 2. Look up commenter's identity link via trust policy cache
 * 3. Check ci_trust level (must be write+)
 * 4. Find held runs for the PR
 * 5. Approve or reject held runs
 */
export async function handleApprovalComment(
  params: HandleApprovalCommentParams,
): Promise<HandleApprovalResult> {
  const {
    commentBody,
    commenterUsername,
    commenterUserId,
    provider,
    repoIdentifier,
    prNumber,
    orgId,
    identityLinks,
    orgMemberPermissions,
    heldRunStore,
  } = params;

  // 1. Parse command
  const command = parseKiciCommand(commentBody);
  if (!command) {
    return { handled: false };
  }

  logger.info('Processing /kici command', {
    action: command.action,
    commenter: commenterUsername,
    runId: command.runId,
  });

  // 2. Look up commenter's identity link (numeric id only)
  const identityLink = findIdentityLink(
    identityLinks,
    provider,
    commenterUsername,
    commenterUserId,
  );
  if (!identityLink) {
    logger.info('No identity link for commenter', { commenter: commenterUsername, provider });
    return { handled: false, reason: 'No identity link for commenter' };
  }

  // 3. Check ci_trust level
  const ciTrustLevel = orgMemberPermissions.get(identityLink.userId) ?? 'none';

  if (ciTrustLevel !== 'write' && ciTrustLevel !== 'admin') {
    logger.info('Insufficient ci_trust level', {
      commenter: commenterUsername,
      userId: identityLink.userId,
      ciTrustLevel,
    });
    return { handled: false, reason: 'Insufficient ci_trust level' };
  }

  // 4. Find pending security holds for THIS PR (repo + pr_number scoped) so a
  //    /kici command never releases holds from unrelated PRs (or repos) in the
  //    org. A hold whose run has a NULL pr_number is excluded by the scoped
  //    query — fail-closed, we only release holds we can attribute to this PR.
  const pendingHolds = await heldRunStore.listPendingSecurityHoldsForPr(
    orgId,
    repoIdentifier,
    prNumber,
  );

  if (pendingHolds.length === 0) {
    logger.info('No pending security holds found for PR', { orgId, repoIdentifier, prNumber });
    return { handled: true };
  }

  // 5. Filter to a specific run within this PR's scoped set if a runId was
  //    given, otherwise process all of the PR's pending holds. Because the set
  //    is already repo+PR scoped, an explicit runId that belongs to a different
  //    PR or repo matches nothing here — the explicit path is not a bypass.
  const targetHolds = command.runId
    ? pendingHolds.filter((h) => h.run_id === command.runId)
    : pendingHolds;

  if (targetHolds.length === 0) {
    logger.info('No matching security holds found', { orgId, runId: command.runId });
    return { handled: true };
  }

  // 6. Approve or reject, and terminalize each ended hold's own security check.
  //
  // Per hold rather than once for the command, because each hold names its own
  // commit: a PR whose contributor pushed again while a hold was pending has
  // two holds on two shas, and one aggregate post would resolve neither
  // correctly. The settler declines for a hold that posted no pending check —
  // a security-typed workflow install gate lands in this queue-type-scoped set
  // and posts none — so it can never fabricate one.
  const approved = command.action === 'approve';
  for (const hold of targetHolds) {
    try {
      if (approved) {
        await heldRunStore.approveByQueueType(orgId, hold.id, identityLink.userId, 'security');
        logger.info('Security hold approved', {
          heldRunId: hold.id,
          runId: hold.run_id,
          approvedBy: identityLink.userId,
        });
        // BEFORE the resume: a replayed dispatch can hold again and post its
        // own pending status, and that pending status must be the last write,
        // not this `success`. See `settleSecurityHoldCheck`.
        await settleSecurityCheckForOutcome({
          db: params.db,
          resolvePoster: params.resolvePoster,
          hold,
          outcome: HoldOutcome.Approved,
          actor: commenterUsername,
          via: APPROVE_COMMAND,
        });
        // Approving must RUN the gated work, not merely mark it approved.
        // `approveByQueueType` has already moved the row to `approved`, which is
        // what lets a job-scoped resume past `dispatchReadyJob`'s
        // `hasPendingHold` gate; a workflow-scoped resume reads the stored
        // dispatch context and not the hold row at all. A resume failure is
        // logged and does not abort the remaining holds — the approval itself
        // has landed either way.
        if (params.onJobRelease) {
          await routeRelease(toReleaseSignal(hold), {
            onJobRelease: params.onJobRelease,
            onWorkflowRelease: params.onWorkflowRelease,
          }).catch((err) => {
            logger.error('Failed to resume a held run after its security hold was approved', {
              heldRunId: hold.id,
              runId: hold.run_id,
              jobId: hold.job_id,
              holdScope: hold.hold_scope,
              error: toErrorMessage(err),
            });
          });
        }
      } else {
        const rejectReason = `Rejected by ${commenterUsername} via ${REJECT_COMMAND}`;
        await heldRunStore.reject(orgId, hold.id, rejectReason);
        logger.info('Security hold rejected', {
          heldRunId: hold.id,
          runId: hold.run_id,
          rejectedBy: commenterUsername,
        });
        // A workflow-scoped hold owns a stored dispatch context and a live
        // `held` run row. Rejecting only the hold row would leave both behind:
        // the run stays alive forever and the context is never replayed nor
        // dropped. Mirrors the dashboard applier's own workflow-reject arm.
        let securityCheckWritten = false;
        if (hold.hold_scope === HoldScope.enum.workflow && params.onWorkflowReject) {
          await params
            .onWorkflowReject(hold, rejectReason)
            .then((posted) => {
              securityCheckWritten = posted;
            })
            .catch((err) => {
              logger.error('Failed to cancel a held run after its security hold was rejected', {
                heldRunId: hold.id,
                runId: hold.run_id,
                error: toErrorMessage(err),
              });
            });
        }
        // The handler it was delegated to completes that hold's security check
        // as `cancelled`, under the same summary the `kici/…` checks of the run
        // carry. Posting again would make two writers of one check run, the
        // second overwriting the first's title, summary and conclusion with a
        // different phrasing of the same event. A hold no write covered — no
        // wiring, a failed call, or a job-scoped hold that has no delegate at
        // all — is still this handler's to report, in that same phrasing.
        if (!securityCheckWritten) {
          await settleSecurityCheckForOutcome({
            db: params.db,
            resolvePoster: params.resolvePoster,
            hold,
            outcome: HoldOutcome.Rejected,
            reason: rejectReason,
          });
        }
      }
    } catch (err) {
      logger.error('Failed to process security hold', {
        heldRunId: hold.id,
        action: command.action,
        error: toErrorMessage(err),
      });
    }
  }

  return { handled: true };
}
