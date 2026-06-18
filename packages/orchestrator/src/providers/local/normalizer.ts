/**
 * Local filesystem source webhook normalizer.
 *
 * Implements the WebhookNormalizer interface from @kici-dev/engine for local
 * (`file://`) sources. Drives the full webhook processing pipeline without a
 * remote forge: signature verification is skipped (local sources use
 * verification='none'), and event type / routing key are extracted from custom
 * headers.
 */

import type { WebhookNormalizer, SimulatedEvent, AccessCacheInvalidation } from '@kici-dev/engine';

/**
 * Local provider implementation of WebhookNormalizer.
 *
 * Maps the synthetic webhook headers and payloads sent to a local source into
 * KiCI's universal SimulatedEvent format. Payloads use the same GitHub-shaped
 * structure the trigger CLI / post-receive hook build
 * (e.g., {ref: 'refs/heads/master', repository: {full_name: 'test/repo'}}).
 */
export class LocalWebhookNormalizer implements WebhookNormalizer {
  readonly provider = 'local' as const;

  /**
   * Extract routing key from the local-source webhook headers.
   *
   * Checks x-kici-routing-key first (explicit routing), then falls back
   * to x-kici-source-id (generic source ID format).
   */
  extractRoutingKey(headers: Record<string, string>, _payload: unknown): string | null {
    return headers['x-kici-routing-key'] ?? headers['x-kici-source-id'] ?? null;
  }

  /**
   * Extract delivery ID for deduplication.
   *
   * Checks x-delivery-id first, falls back to x-request-id.
   */
  extractDeliveryId(headers: Record<string, string>): string | null {
    return headers['x-delivery-id'] ?? headers['x-request-id'] ?? null;
  }

  /**
   * Extract event type from x-event-type header.
   */
  extractEventType(headers: Record<string, string>): string | null {
    return headers['x-event-type'] ?? null;
  }

  /**
   * Verify signature -- always returns true.
   *
   * Local sources use verification='none' — there is no remote forge to sign
   * the payload. The operator is responsible for only registering repos they
   * trust (see docs/user/providers/local-file.md).
   */
  verifySignature(_body: string, _headers: Record<string, string>, _secret: string): boolean {
    return true;
  }

  /**
   * Extract repository identifier from a local-source webhook payload.
   *
   * Local-source events use GitHub-shaped payloads, so we extract from
   * payload.repository.full_name if present.
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
   * Extract ref from a local-source webhook payload.
   *
   * Local-source events use GitHub-shaped payloads, so extraction logic
   * mirrors GitHub's: push -> payload.after, PR -> payload.pull_request.head.sha.
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
      default: {
        return 'HEAD';
      }
    }
  }

  /**
   * Extract credentials -- local sources carry no provider credentials.
   */
  extractCredentials(_payload: unknown): Record<string, unknown> {
    return {};
  }

  /**
   * Normalize a local-source webhook event into a SimulatedEvent.
   *
   * Extracts branch information from payload.ref (stripping refs/heads/ prefix)
   * and preserves the raw payload for trigger matching. Falls back to '__local__'
   * when no ref is present.
   */
  normalizeEvent(
    eventType: string,
    _action: string | null,
    payload: unknown,
  ): SimulatedEvent | null {
    const p = (payload as Record<string, unknown>) ?? {};

    // Extract action from payload if present
    const action = typeof p.action === 'string' ? p.action : undefined;

    // Extract target branch from ref field (strip refs/heads/ prefix)
    let targetBranch = '__local__';
    if (typeof p.ref === 'string') {
      const ref = p.ref;
      if (ref.startsWith('refs/heads/')) {
        targetBranch = ref.slice('refs/heads/'.length);
      } else if (ref.startsWith('refs/tags/')) {
        targetBranch = ref.slice('refs/tags/'.length);
      } else {
        targetBranch = ref;
      }
    }

    return {
      type: eventType,
      action,
      targetBranch,
      payload: p,
      provider: 'local',
    };
  }

  /**
   * Map membership-related local-source webhook events to ContributorCache
   * invalidations.
   *
   * Local-source payloads are GitHub-shaped by design, so the mapping
   * mirrors the GitHub normalizer exactly:
   *
   * - `member`: repo-user
   * - `organization`: user-in-org
   * - `membership`: user-in-org
   * - `team` (repo-scoped actions only): repo
   *
   * This lets membership-invalidation paths be exercised through
   * `sendLocalWebhook()` without requiring a real GitHub App.
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
