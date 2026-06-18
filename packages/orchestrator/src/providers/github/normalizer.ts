/**
 * GitHub webhook normalizer.
 *
 * Implements the WebhookNormalizer interface from @kici-dev/engine for GitHub webhooks.
 * Handles header extraction, HMAC-SHA256 signature verification, and event normalization.
 */

import type { WebhookNormalizer, SimulatedEvent, AccessCacheInvalidation } from '@kici-dev/engine';
import { verifySignature as verifyHmacSignature } from '@kici-dev/engine/webhook/signature';

/**
 * GitHub-specific implementation of WebhookNormalizer.
 *
 * Maps GitHub webhook headers and payloads to KiCI's universal format.
 * Headers are expected lowercase (Hono normalizes them).
 */
export class GitHubWebhookNormalizer implements WebhookNormalizer {
  readonly provider = 'github' as const;

  /**
   * Extract routing key from GitHub webhook headers.
   *
   * Uses the X-GitHub-Hook-Installation-Target-ID header which identifies
   * the GitHub App receiving the webhook.
   *
   * @returns "github:{appId}" or null if header is missing
   */
  extractRoutingKey(headers: Record<string, string>, _payload: unknown): string | null {
    const targetId = headers['x-github-hook-installation-target-id'];
    if (!targetId) {
      return null;
    }
    return `github:${targetId}`;
  }

  /**
   * Extract delivery ID from X-GitHub-Delivery header.
   *
   * GitHub sends a UUID as the delivery identifier for deduplication.
   */
  extractDeliveryId(headers: Record<string, string>): string | null {
    return headers['x-github-delivery'] ?? null;
  }

  /**
   * Extract event type from X-GitHub-Event header.
   *
   * Returns the raw GitHub event type (e.g., "push", "pull_request").
   */
  extractEventType(headers: Record<string, string>): string | null {
    return headers['x-github-event'] ?? null;
  }

  /**
   * Verify webhook signature using HMAC-SHA256.
   *
   * GitHub signs webhooks with the X-Hub-Signature-256 header using
   * the shared webhook secret configured on the GitHub App.
   */
  verifySignature(body: string, headers: Record<string, string>, secret: string): boolean {
    const signature = headers['x-hub-signature-256'];
    if (!signature) {
      return false;
    }
    return verifyHmacSignature(body, signature, secret);
  }

  /**
   * Normalize a GitHub webhook event into a SimulatedEvent.
   *
   * Handles all 15 supported GitHub event types:
   * - pull_request, push, issue_comment, pull_request_review,
   *   pull_request_review_comment, repository_dispatch, release,
   *   create, delete, status, workflow_run, fork, star, watch
   * - push events with refs/tags/ prefix return type: 'tag'
   *
   * Returns null for events not in the supported list.
   */
  normalizeEvent(
    eventType: string,
    action: string | null,
    payload: unknown,
  ): SimulatedEvent | null {
    const p = payload as Record<string, unknown>;
    const sender = extractSenderIdentity(p);

    const handler = EVENT_HANDLERS[eventType];
    if (!handler) {
      // Unknown event type -- not matchable
      return null;
    }
    return handler(p, action, sender);
  }

  /**
   * Extract repository identifier from a GitHub webhook payload.
   *
   * Prefers repository.full_name, falls back to owner.login/name.
   */
  extractRepoIdentifier(payload: unknown): string | null {
    const p = payload as Record<string, unknown>;
    const repository = p.repository as
      | { full_name?: string; owner?: { login?: string }; name?: string }
      | undefined;

    return (
      repository?.full_name ??
      (repository?.owner?.login && repository?.name
        ? `${repository.owner.login}/${repository.name}`
        : null)
    );
  }

  /**
   * Extract commit SHA or ref from a GitHub webhook payload.
   *
   * Maps each GitHub event type to the appropriate payload field
   * for lock file fetching.
   */
  extractRef(eventType: string, payload: unknown): string {
    const p = payload as Record<string, unknown>;
    switch (eventType) {
      case 'push': {
        return (p.after as string) ?? 'HEAD';
      }
      case 'pull_request':
      case 'pull_request_review':
      case 'pull_request_review_comment': {
        const pr = p.pull_request as { head?: { sha?: string } } | undefined;
        return pr?.head?.sha ?? 'HEAD';
      }
      case 'status': {
        return (p.sha as string) ?? 'HEAD';
      }
      case 'release': {
        const release = p.release as { target_commitish?: string } | undefined;
        return release?.target_commitish ?? 'HEAD';
      }
      default: {
        return 'HEAD';
      }
    }
  }

  /**
   * Extract GitHub-specific credentials from a webhook payload.
   *
   * Extracts installationId from payload.installation.id, needed for
   * generating installation tokens for repo access.
   */
  extractCredentials(payload: unknown): Record<string, unknown> {
    const p = payload as Record<string, unknown>;
    const installation = p.installation as Record<string, unknown> | undefined;
    const installationId =
      installation && typeof installation.id === 'number' ? installation.id : null;
    return { installationId };
  }

  /**
   * Map GitHub membership-related webhook events to ContributorCache
   * invalidations. See WebhookNormalizer.getAccessCacheInvalidations.
   *
   * Covered event types:
   *
   * - `member` (`added` / `removed` / `edited`): a collaborator's repo
   *   permission changed -> `repo-user` invalidation for the exact
   *   `{repo, user}` pair.
   * - `organization` (`member_added` / `member_removed`): a user was added
   *   to or removed from the org. The user's effective permission on every
   *   repo under the org may have shifted -> `user-in-org`.
   * - `membership` (`added` / `removed`, usually team scope): same reasoning
   *   as `organization`. Slightly broader than strictly required, but the
   *   cache refills cheaply and over-invalidation is safe.
   * - `team` (`added_to_repository` / `removed_from_repository`): every
   *   member of the team gained or lost repo access -> `repo`.
   *
   * Any other event type (including other `team` actions like `created` /
   * `deleted` / `edited` which carry no repo context) returns `[]`.
   *
   * Payload fields are probed defensively; a missing field returns `[]`
   * rather than throwing — this is best-effort and we do not want a
   * malformed payload to crash webhook processing.
   */
  getAccessCacheInvalidations(
    eventType: string,
    _action: string | null,
    payload: unknown,
  ): AccessCacheInvalidation[] {
    if (payload === null || typeof payload !== 'object') return [];
    const p = payload as Record<string, unknown>;

    switch (eventType) {
      case 'member': {
        const repo = p.repository as { full_name?: string } | undefined;
        const member = p.member as { login?: string } | undefined;
        const repoFullName = repo?.full_name;
        const username = member?.login;
        if (!repoFullName || !username) return [];
        return [{ kind: 'repo-user', repoFullName, username }];
      }

      case 'organization': {
        const org = p.organization as { login?: string } | undefined;
        const membership = p.membership as { user?: { login?: string } } | undefined;
        const orgLogin = org?.login;
        const username = membership?.user?.login;
        if (!orgLogin || !username) return [];
        return [{ kind: 'user-in-org', orgLogin, username }];
      }

      case 'membership': {
        const org = p.organization as { login?: string } | undefined;
        const member = p.member as { login?: string } | undefined;
        const orgLogin = org?.login;
        const username = member?.login;
        if (!orgLogin || !username) return [];
        return [{ kind: 'user-in-org', orgLogin, username }];
      }

      case 'team': {
        // Only repo-scoped actions carry a repository field.
        const repo = p.repository as { full_name?: string } | undefined;
        const repoFullName = repo?.full_name;
        if (!repoFullName) return [];
        return [{ kind: 'repo', repoFullName }];
      }

      default:
        return [];
    }
  }
}

/**
 * Extract the default branch from a GitHub webhook payload.
 * Falls back to 'main' if repository.default_branch is not present.
 */
function getDefaultBranch(payload: Record<string, unknown>): string {
  const repository = payload.repository as { default_branch?: string } | undefined;
  return repository?.default_branch ?? 'main';
}

/**
 * Sender identity shared across all event-type handlers.
 *
 * The numeric `userId` is the trust identifier: GitHub logins are mutable
 * and a recycled login can otherwise inherit trust granted to a previous
 * owner. Coerced to string for protocol stability across event shapes.
 */
interface SenderIdentity {
  username: string | undefined;
  userId: string | undefined;
}

function extractSenderIdentity(p: Record<string, unknown>): SenderIdentity {
  const sender = p.sender as { login?: string; id?: number | string } | undefined;
  const username = sender?.login;
  const userId =
    typeof sender?.id === 'number' && Number.isFinite(sender.id)
      ? String(sender.id)
      : typeof sender?.id === 'string' && sender.id.length > 0
        ? sender.id
        : undefined;
  return { username, userId };
}

/** Per-event-type extractor signature shared by every entry in EVENT_HANDLERS. */
type EventHandler = (
  p: Record<string, unknown>,
  action: string | null,
  sender: SenderIdentity,
) => SimulatedEvent | null;

/**
 * Common PR-shape extraction reused by `pull_request` /
 * `pull_request_review` / `pull_request_review_comment` handlers.
 */
type PullRequestShape = {
  base?: { ref?: string; repo?: { full_name?: string } };
  head?: { ref?: string; repo?: { full_name?: string } };
};

function isForkPullRequest(pr: PullRequestShape | undefined): boolean {
  const headRepo = pr?.head?.repo?.full_name;
  const baseRepo = pr?.base?.repo?.full_name;
  return headRepo !== undefined && baseRepo !== undefined && headRepo !== baseRepo;
}

const handlePullRequest: EventHandler = (p, action, sender) => {
  const pr = p.pull_request as PullRequestShape | undefined;
  const targetBranch = pr?.base?.ref;
  const sourceBranch = pr?.head?.ref;
  if (!targetBranch) return null;

  return {
    type: 'pull_request',
    action: action ?? undefined,
    targetBranch,
    sourceBranch: sourceBranch ?? undefined,
    baseBranch: targetBranch,
    isForkPR: isForkPullRequest(pr),
    senderUsername: sender.username,
    senderUserId: sender.userId,
    payload: p,
    provider: 'github',
  };
};

const handlePush: EventHandler = (p, _action, sender) => {
  const ref = p.ref as string | undefined;
  if (!ref) return null;

  // Tag pushes: refs/tags/v1.0.0 -> type: 'tag', targetBranch: 'v1.0.0'
  if (ref.startsWith('refs/tags/')) {
    return {
      type: 'tag',
      targetBranch: ref.slice('refs/tags/'.length),
      senderUsername: sender.username,
      senderUserId: sender.userId,
      payload: p,
      provider: 'github',
    };
  }

  // Branch pushes: strip refs/heads/ prefix
  const targetBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  return {
    type: 'push',
    targetBranch,
    senderUsername: sender.username,
    senderUserId: sender.userId,
    payload: p,
    provider: 'github',
  };
};

const handleIssueComment: EventHandler = (p, action, sender) => ({
  type: 'comment',
  action: action ?? undefined,
  targetBranch: getDefaultBranch(p),
  senderUsername: sender.username,
  senderUserId: sender.userId,
  payload: p,
  provider: 'github',
});

const handlePullRequestReview: EventHandler = (p, action, sender) => {
  const pr = p.pull_request as PullRequestShape | undefined;
  const prBaseBranch = pr?.base?.ref ?? getDefaultBranch(p);
  return {
    type: 'review',
    action: action ?? undefined,
    targetBranch: prBaseBranch,
    sourceBranch: pr?.head?.ref ?? undefined,
    baseBranch: prBaseBranch,
    isForkPR: isForkPullRequest(pr),
    senderUsername: sender.username,
    senderUserId: sender.userId,
    payload: p,
    provider: 'github',
  };
};

const handlePullRequestReviewComment: EventHandler = (p, action, sender) => {
  const pr = p.pull_request as PullRequestShape | undefined;
  const prBaseBranch = pr?.base?.ref ?? getDefaultBranch(p);
  return {
    type: 'review_comment',
    action: action ?? undefined,
    targetBranch: prBaseBranch,
    sourceBranch: pr?.head?.ref ?? undefined,
    baseBranch: prBaseBranch,
    isForkPR: isForkPullRequest(pr),
    senderUsername: sender.username,
    senderUserId: sender.userId,
    payload: p,
    provider: 'github',
  };
};

const handleRepositoryDispatch: EventHandler = (p, _action, sender) => ({
  type: 'dispatch',
  action: (p.action as string) ?? undefined,
  targetBranch: getDefaultBranch(p),
  senderUsername: sender.username,
  senderUserId: sender.userId,
  payload: p,
  provider: 'github',
});

const handleRelease: EventHandler = (p, action, sender) => {
  const release = p.release as { target_commitish?: string } | undefined;
  return {
    type: 'release',
    action: action ?? undefined,
    targetBranch: release?.target_commitish ?? getDefaultBranch(p),
    senderUsername: sender.username,
    senderUserId: sender.userId,
    payload: p,
    provider: 'github',
  };
};

const handleCreate: EventHandler = (p, _action, sender) => ({
  type: 'create',
  targetBranch: (p.ref as string) ?? getDefaultBranch(p),
  senderUsername: sender.username,
  senderUserId: sender.userId,
  payload: p,
  provider: 'github',
});

const handleDelete: EventHandler = (p, _action, sender) => ({
  type: 'delete',
  targetBranch: (p.ref as string) ?? getDefaultBranch(p),
  senderUsername: sender.username,
  senderUserId: sender.userId,
  payload: p,
  provider: 'github',
});

const handleStatus: EventHandler = (p, _action, sender) => {
  const branches = p.branches as Array<{ name?: string }> | undefined;
  return {
    type: 'status',
    targetBranch: branches?.[0]?.name ?? getDefaultBranch(p),
    senderUsername: sender.username,
    senderUserId: sender.userId,
    payload: p,
    provider: 'github',
  };
};

const handleWorkflowRun: EventHandler = (p, action, sender) => {
  const workflowRun = p.workflow_run as { head_branch?: string } | undefined;
  return {
    type: 'workflow_run',
    action: action ?? undefined,
    targetBranch: workflowRun?.head_branch ?? getDefaultBranch(p),
    senderUsername: sender.username,
    senderUserId: sender.userId,
    payload: p,
    provider: 'github',
  };
};

const handleFork: EventHandler = (p, _action, sender) => ({
  type: 'fork',
  targetBranch: getDefaultBranch(p),
  senderUsername: sender.username,
  senderUserId: sender.userId,
  payload: p,
  provider: 'github',
});

const handleStar: EventHandler = (p, action, sender) => ({
  type: 'star',
  action: action ?? undefined,
  targetBranch: getDefaultBranch(p),
  senderUsername: sender.username,
  senderUserId: sender.userId,
  payload: p,
  provider: 'github',
});

const handleWatch: EventHandler = (p, action, sender) => ({
  type: 'watch',
  action: action ?? undefined,
  targetBranch: getDefaultBranch(p),
  senderUsername: sender.username,
  senderUserId: sender.userId,
  payload: p,
  provider: 'github',
});

/**
 * Per-event-type handler dispatch table. Each entry is a small function
 * that maps a GitHub webhook payload of a specific event type onto the
 * universal SimulatedEvent shape. Adding a new event type means adding a
 * new `handle<Event>` function and a row here — no edits to
 * normalizeEvent itself.
 */
const EVENT_HANDLERS: Record<string, EventHandler> = {
  pull_request: handlePullRequest,
  push: handlePush,
  issue_comment: handleIssueComment,
  pull_request_review: handlePullRequestReview,
  pull_request_review_comment: handlePullRequestReviewComment,
  repository_dispatch: handleRepositoryDispatch,
  release: handleRelease,
  create: handleCreate,
  delete: handleDelete,
  status: handleStatus,
  workflow_run: handleWorkflowRun,
  fork: handleFork,
  star: handleStar,
  watch: handleWatch,
};
