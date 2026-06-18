/**
 * WebhookNormalizer interface.
 *
 * Translates provider-specific webhook HTTP requests into KiCI's universal
 * SimulatedEvent format. Each provider implements this to handle its own
 * header conventions, signature schemes, and payload structures.
 */

import type { SimulatedEvent } from '../trigger/types.js';
import type { ProviderType } from './types.js';

/**
 * Discriminated union describing which `ContributorCache` entries a webhook
 * event invalidates. Returned by `WebhookNormalizer.getAccessCacheInvalidations`.
 *
 * Three scopes:
 * - `repo-user`: a single `{repo, user}` permission changed (e.g. GitHub
 *   `member` event on a specific collaborator).
 * - `repo`: every contributor's effective permission on a repo may have
 *   shifted (e.g. a team was added/removed from the repo).
 * - `user-in-org`: a user's org membership changed, so any repo under that
 *   org may now return a different permission for them.
 */
export type AccessCacheInvalidation =
  | { kind: 'repo-user'; repoFullName: string; username: string }
  | { kind: 'repo'; repoFullName: string }
  | { kind: 'user-in-org'; orgLogin: string; username: string };

export interface WebhookNormalizer {
  readonly provider: ProviderType;

  /**
   * Extract a routing key from webhook headers/payload.
   *
   * The routing key uniquely identifies a webhook source within KiCI.
   * Format: "{provider}:{provider-specific-id}"
   *
   * Examples:
   * - GitHub: "github:12345" from X-GitHub-Hook-Installation-Target-ID header
   * - GitLab: "gitlab:67890" from payload.project.id
   * - Bitbucket: "bitbucket:{uuid}" from payload.repository.uuid
   */
  extractRoutingKey(headers: Record<string, string>, payload: unknown): string | null;

  /**
   * Extract a unique delivery ID for deduplication.
   *
   * Examples:
   * - GitHub: X-GitHub-Delivery header
   * - GitLab: X-Gitlab-Event-UUID header
   * - Bitbucket: X-Request-UUID header
   */
  extractDeliveryId(headers: Record<string, string>): string | null;

  /**
   * Extract the event type from headers.
   *
   * Returns the provider-specific event type string (not yet normalized).
   *
   * Examples:
   * - GitHub: X-GitHub-Event header ("push", "pull_request")
   * - GitLab: X-Gitlab-Event header ("Push Hook", "Merge Request Hook")
   * - Bitbucket: X-Event-Key header ("repo:push", "pullrequest:created")
   */
  extractEventType(headers: Record<string, string>): string | null;

  /**
   * Verify webhook signature or token.
   *
   * Each provider has its own verification scheme:
   * - GitHub: HMAC-SHA256 with X-Hub-Signature-256 header
   * - GitLab: Plain token comparison with X-Gitlab-Token header
   * - Bitbucket: HMAC-SHA256 with X-Hub-Signature header
   *
   * @param body - Raw request body as string
   * @param headers - Request headers (lowercase keys)
   * @param secret - Webhook secret/token configured for this source
   * @returns true if signature/token is valid
   */
  verifySignature(body: string, headers: Record<string, string>, secret: string): boolean;

  /**
   * Normalize a provider-specific webhook into a SimulatedEvent.
   *
   * Maps provider event types to universal 'pull_request' | 'push' types.
   * Returns null if the event type is not relevant for trigger matching
   * (e.g., GitHub "star" events, GitLab "Pipeline Hook" events).
   *
   * @param eventType - Provider-specific event type (from extractEventType)
   * @param action - Event action/sub-type, if applicable (e.g., "opened" for PRs)
   * @param payload - Raw webhook payload
   * @returns Normalized SimulatedEvent, or null if not matchable
   */
  normalizeEvent(eventType: string, action: string | null, payload: unknown): SimulatedEvent | null;

  /**
   * Extract the repository identifier from a webhook payload.
   *
   * Returns a string in "owner/repo" format, or null if the payload
   * does not contain repository information (e.g., generic webhooks).
   *
   * Examples:
   * - GitHub: "octocat/Hello-World" from payload.repository.full_name
   * - GitLab: "group/project" from payload.project.path_with_namespace
   * - Generic/internal: may return null if no repo concept
   */
  extractRepoIdentifier(payload: unknown): string | null;

  /**
   * Extract the commit SHA or ref for lock file fetching from a webhook payload.
   *
   * Returns a commit SHA, branch name, or 'HEAD' as a fallback.
   * Each provider maps event types to the appropriate payload field.
   *
   * Examples:
   * - GitHub push: payload.after
   * - GitHub pull_request: payload.pull_request.head.sha
   * - Generic: 'HEAD' (no ref concept)
   *
   * @param eventType - Provider-specific event type (from extractEventType)
   * @param payload - Raw webhook payload
   */
  extractRef(eventType: string, payload: unknown): string;

  /**
   * Extract provider-specific credentials from a webhook payload.
   *
   * Returns an object with provider-specific credential fields needed
   * for downstream operations (clone tokens, API calls, etc.).
   *
   * Examples:
   * - GitHub: { installationId: 12345 } from payload.installation.id
   * - Generic: {} (no credentials in payload)
   */
  extractCredentials(payload: unknown): Record<string, unknown>;

  /**
   * Extract the repository's default branch from the webhook payload.
   *
   * Optional. When implemented, the orchestrator uses this hook to decide
   * whether a push event targets the default branch (required for workflow
   * registration extraction). When omitted, the orchestrator falls back to
   * the hardcoded `payload.repository.default_branch` shape.
   *
   * Returns null when the field is missing or cannot be resolved.
   */
  extractDefaultBranch?(payload: unknown): string | null;

  /**
   * Map a webhook event to the `ContributorCache` entries it should drop.
   *
   * Optional. When implemented, the orchestrator calls this before
   * `normalizeEvent` and invalidates every returned entry so the next
   * permission check hits the provider API instead of relying on stale
   * cached data. Events that do not imply a permission shift (most events,
   * including `push` / `pull_request` / etc.) should return `[]`.
   *
   * The caller is responsible for pairing the returned entries with the
   * `provider` field of the matched bundle — this method receives no
   * provider argument.
   *
   * @param eventType Provider-specific event type (from extractEventType).
   * @param action Event action/sub-type, if applicable.
   * @param payload Raw webhook payload.
   */
  getAccessCacheInvalidations?(
    eventType: string,
    action: string | null,
    payload: unknown,
  ): AccessCacheInvalidation[];
}
