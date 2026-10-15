/**
 * Translates a provider's webhook HTTP requests (its header conventions,
 * signature scheme and payload structure) into KiCI's universal SimulatedEvent.
 */

import type { SimulatedEvent } from '../trigger/types.js';
import type { ProviderType } from './types.js';

export interface WebhookNormalizer {
  readonly provider: ProviderType;

  /**
   * Extract the routing key that uniquely identifies a webhook source within
   * KiCI. Format: "{provider}:{provider-specific-id}"
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
   * Extract the provider-specific event type (not yet normalized) from headers.
   *
   * Examples:
   * - GitHub: X-GitHub-Event header ("push", "pull_request")
   * - GitLab: X-Gitlab-Event header ("Push Hook", "Merge Request Hook")
   * - Bitbucket: X-Event-Key header ("repo:push", "pullrequest:created")
   */
  extractEventType(headers: Record<string, string>): string | null;

  /**
   * Verify the webhook signature or token. Each provider has its own scheme:
   * - GitHub: HMAC-SHA256 with X-Hub-Signature-256 header
   * - GitLab: Plain token comparison with X-Gitlab-Token header
   * - Bitbucket: HMAC-SHA256 with X-Hub-Signature header
   *
   * @param body - Raw request body
   * @param headers - Request headers (lowercase keys)
   * @param secret - Webhook secret/token configured for this source
   */
  verifySignature(body: string, headers: Record<string, string>, secret: string): boolean;

  /**
   * Normalize a provider-specific webhook into a SimulatedEvent, mapping
   * provider event types to universal 'pull_request' | 'push' types. Returns
   * null if the event type is not relevant for trigger matching (e.g., GitHub
   * "star" events, GitLab "Pipeline Hook" events).
   *
   * @param eventType - Provider-specific event type (from extractEventType)
   * @param action - Event action/sub-type, if applicable (e.g., "opened" for PRs)
   */
  normalizeEvent(eventType: string, action: string | null, payload: unknown): SimulatedEvent | null;

  /**
   * Extract the repository identifier in "owner/repo" format, or null if the
   * payload has no repository information (e.g., generic webhooks).
   *
   * Examples:
   * - GitHub: "octocat/Hello-World" from payload.repository.full_name
   * - GitLab: "group/project" from payload.project.path_with_namespace
   * - Generic/internal: may return null if no repo concept
   */
  extractRepoIdentifier(payload: unknown): string | null;

  /**
   * Extract the ref for lock file fetching: a commit SHA, branch name, or
   * 'HEAD' as a fallback, from the payload field matching the event type.
   *
   * Examples:
   * - GitHub push: payload.after
   * - GitHub pull_request: payload.pull_request.head.sha
   * - Generic: 'HEAD' (no ref concept)
   *
   * @param eventType - Provider-specific event type (from extractEventType)
   */
  extractRef(eventType: string, payload: unknown): string;

  /**
   * Extract the provider-specific credential fields downstream operations
   * (clone tokens, API calls, etc.) need.
   *
   * Examples:
   * - GitHub: { installationId: 12345 } from payload.installation.id
   * - Generic: {} (no credentials in payload)
   */
  extractCredentials(payload: unknown): Record<string, unknown>;

  /**
   * Extract the repository's default branch, or null when missing or
   * unresolvable. The orchestrator uses it to decide whether a push targets the
   * default branch (required for workflow registration extraction); when
   * omitted, it falls back to `payload.repository.default_branch`.
   */
  extractDefaultBranch?(payload: unknown): string | null;
}
