/**
 * /kici approve and /kici reject comment command handler.
 *
 * Parses issue_comment webhook bodies for /kici commands and handles
 * approval/rejection of security holds. Verifies commenter identity
 * via the trust policy cache and checks ci_trust:write+ before acting.
 */

import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { HeldRunStore } from '../environments/held-runs.js';
import { findIdentityLink, type IdentityLink, type PermissionLevel } from './trust-resolver.js';
import type { CheckStatusPoster as EngineCheckStatusPoster } from '@kici-dev/engine';

const logger = createLogger({ prefix: 'comment-handler' });

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
   * Commenter immutable IDP-side numeric id from the webhook event. Used to
   * match the identity link by id first, falling back to username during the
   * backfill window (see trust-resolver.findIdentityLink).
   */
  commenterUserId?: string;
  provider: string;
  repoIdentifier: string;
  prNumber: number;
  orgId: string;
  identityLinks: IdentityLink[];
  orgMemberPermissions: Map<string, PermissionLevel>;
  heldRunStore: HeldRunStore;
  /** Check status poster for updating GitHub checks after approval/rejection. */
  checkStatusPoster?: EngineCheckStatusPoster;
  /** Commit SHA for the PR head (needed for check status updates). */
  commitSha?: string;
  credentials: unknown;
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

  // 2. Look up commenter's identity link (numeric-id-first, username fallback)
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

  // 4. Find pending security holds for this org
  const pendingHolds = await heldRunStore.listByQueueType(orgId, 'security', { status: 'pending' });

  if (pendingHolds.length === 0) {
    logger.info('No pending security holds found', { orgId });
    return { handled: true };
  }

  // 5. Filter to specific run if provided, otherwise process all pending
  const targetHolds = command.runId
    ? pendingHolds.filter((h) => h.run_id === command.runId)
    : pendingHolds;

  if (targetHolds.length === 0) {
    logger.info('No matching security holds found', { orgId, runId: command.runId });
    return { handled: true };
  }

  // 6. Approve or reject
  const approved = command.action === 'approve';
  let processedCount = 0;
  for (const hold of targetHolds) {
    try {
      if (approved) {
        await heldRunStore.approveByQueueType(orgId, hold.id, identityLink.userId, 'security');
        logger.info('Security hold approved', {
          heldRunId: hold.id,
          runId: hold.run_id,
          approvedBy: identityLink.userId,
        });
      } else {
        await heldRunStore.reject(
          orgId,
          hold.id,
          `Rejected by ${commenterUsername} via /kici reject`,
        );
        logger.info('Security hold rejected', {
          heldRunId: hold.id,
          runId: hold.run_id,
          rejectedBy: commenterUsername,
        });
      }
      processedCount++;
    } catch (err) {
      logger.error('Failed to process security hold', {
        heldRunId: hold.id,
        action: command.action,
        error: toErrorMessage(err),
      });
    }
  }

  // 7. Update GitHub check status (only if at least one hold was processed)
  if (processedCount > 0 && params.checkStatusPoster && params.commitSha) {
    const title = approved ? 'Approved' : 'Rejected';
    const summary = approved
      ? `Approved by ${commenterUsername} via /kici approve`
      : `Rejected by ${commenterUsername} via /kici reject`;

    params.checkStatusPoster
      .postCheckStatus(
        params.repoIdentifier,
        params.commitSha,
        approved ? 'success' : 'failure',
        title,
        summary,
        params.credentials,
      )
      .catch((err) => {
        logger.warn('Failed to update check status after approval', {
          error: toErrorMessage(err),
        });
      });
  }

  return { handled: true };
}
