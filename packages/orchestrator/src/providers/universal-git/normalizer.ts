/**
 * Universal-git webhook normalizer.
 *
 * Implements the `WebhookNormalizer` interface from `@kici-dev/engine` for any
 * forge that emits GitHub-shaped push / PR payloads. The structure of each
 * forge's payload is declared via JSONPath expressions in the source's
 * `git_config.payloadPaths`, so a single class covers Forgejo, Gitea, Gogs,
 * GitLab repo webhooks, and plain-GitHub repo webhooks.
 *
 * Signatures are verified per source in the upstream generic-webhook
 * verification path (HMAC-SHA256 / plain token / IP allow-list); this
 * normalizer therefore short-circuits `verifySignature` and relies on the
 * caller's pre-verification, same as `GenericWebhookNormalizer`.
 */

import type { WebhookNormalizer, SimulatedEvent } from '@kici-dev/engine';
import { JSONPath } from 'jsonpath-plus';
import {
  expandUniversalGitConfig,
  type UniversalGitConfig,
  type UniversalGitPayloadPaths,
  type EventMapping,
} from './config.js';

/**
 * Webhook normalizer for universal-git sources.
 *
 * Each instance is bound to one source's expanded config (preset-resolved
 * `payloadPaths` + `eventMapping`). The orchestrator constructs one per
 * registered `generic_webhook_sources` row with a non-null `git_config`.
 */
export class UniversalGitWebhookNormalizer implements WebhookNormalizer {
  readonly provider = 'generic' as const;

  private readonly routingKey: string;
  private readonly paths: UniversalGitPayloadPaths;
  private readonly eventMapping: EventMapping;

  constructor(params: { routingKey: string; config: UniversalGitConfig }) {
    const expanded = expandUniversalGitConfig(params.config);
    this.routingKey = params.routingKey;
    this.paths = expanded.payloadPaths;
    this.eventMapping = expanded.eventMapping;
  }

  /**
   * Routing key is pre-assigned per source. The generic source-id header is
   * still honoured for test compatibility, but the orchestrator pipeline
   * already knows the routing key by the time this is invoked.
   */
  extractRoutingKey(headers: Record<string, string>, _payload: unknown): string | null {
    return headers['x-kici-source-id'] ?? this.routingKey;
  }

  /**
   * Most universal-git forges send one of the following (in priority order).
   * Returning null lets the pipeline fall back to request-level dedup.
   */
  extractDeliveryId(headers: Record<string, string>): string | null {
    return (
      headers['x-gitea-delivery'] ??
      headers['x-gogs-delivery'] ??
      headers['x-gitlab-event-uuid'] ??
      headers['x-github-delivery'] ??
      headers['x-delivery-id'] ??
      headers['x-request-id'] ??
      null
    );
  }

  /**
   * Event type header varies per forge. We accept all common spellings;
   * `normalizeEvent` collapses the value back to KiCI's canonical names via
   * the source's `eventMapping`.
   */
  extractEventType(headers: Record<string, string>): string | null {
    return (
      headers['x-gitea-event'] ??
      headers['x-gogs-event'] ??
      headers['x-gitlab-event'] ??
      headers['x-github-event'] ??
      headers['x-event-type'] ??
      null
    );
  }

  /**
   * Signature verification is performed by the generic webhook pipeline
   * upstream; the normalizer only cooperates by returning `true`.
   */
  verifySignature(_body: string, _headers: Record<string, string>, _secret: string): boolean {
    return true;
  }

  /**
   * Normalize the forge payload into a `SimulatedEvent`. Uses JSONPath
   * extraction for the repo identifier + ref + SHA so the same code works
   * against every supported forge.
   */
  normalizeEvent(
    eventType: string,
    action: string | null,
    payload: unknown,
  ): SimulatedEvent | null {
    const p = (payload as Record<string, unknown>) ?? {};
    const kind = this.classifyEvent(eventType);
    if (kind === null) {
      return null;
    }

    const senderUsername = extractSenderUsername(p);
    const senderUserId = extractSenderUserId(p);
    const defaultBranch =
      this.extractDefaultBranch(p) ??
      (typeof p.default_branch === 'string' ? p.default_branch : undefined);

    if (kind === 'push') {
      const ref = extractStringPath(p, this.paths.pushRef);
      if (!ref) return null;
      if (ref.startsWith('refs/tags/')) {
        return {
          type: 'tag',
          targetBranch: ref.slice('refs/tags/'.length),
          senderUsername,
          senderUserId,
          payload: p,
          provider: 'generic',
        };
      }
      const targetBranch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      return {
        type: 'push',
        targetBranch,
        senderUsername,
        senderUserId,
        payload: p,
        provider: 'generic',
      };
    }

    // Pull-request-shaped events. Forgejo/Gitea/Gogs use `pull_request`,
    // GitLab uses `object_attributes` — we accept either.
    const pr =
      (p.pull_request as Record<string, unknown> | undefined) ??
      (p.object_attributes as Record<string, unknown> | undefined);
    const base = (pr?.base as Record<string, unknown> | undefined) ?? undefined;
    const head = (pr?.head as Record<string, unknown> | undefined) ?? undefined;
    const targetRef =
      (typeof base?.ref === 'string' ? base.ref : undefined) ??
      (typeof pr?.target_branch === 'string' ? pr.target_branch : undefined) ??
      defaultBranch;
    const sourceRef =
      (typeof head?.ref === 'string' ? head.ref : undefined) ??
      (typeof pr?.source_branch === 'string' ? pr.source_branch : undefined);
    if (!targetRef) return null;

    const headRepoFullName = extractRepoFullName(head);
    const baseRepoFullName = extractRepoFullName(base);
    const isForkPR =
      headRepoFullName !== undefined &&
      baseRepoFullName !== undefined &&
      headRepoFullName !== baseRepoFullName;

    return {
      type: 'pull_request',
      action: action ?? (typeof pr?.action === 'string' ? pr.action : undefined),
      targetBranch: targetRef,
      sourceBranch: sourceRef ?? undefined,
      baseBranch: targetRef,
      isForkPR,
      senderUsername,
      senderUserId,
      payload: p,
      provider: 'generic',
    };
  }

  /**
   * Repo identifier via JSONPath. Returns `null` when the expression
   * yields no match — callers treat this as "no repo context".
   */
  extractRepoIdentifier(payload: unknown): string | null {
    const p = (payload as Record<string, unknown>) ?? {};
    return extractStringPath(p, this.paths.repoIdentifier) ?? null;
  }

  /**
   * Git ref / SHA extraction. For push, we resolve `pushSha`; for PR-shaped
   * events, we fall back to `pull_request.head.sha` (or `object_attributes.last_commit.id`
   * for GitLab). Unknown event types resolve to `HEAD` so the orchestrator
   * can still evaluate triggers against the default branch.
   */
  extractRef(eventType: string, payload: unknown): string {
    const p = (payload as Record<string, unknown>) ?? {};
    const kind = this.classifyEvent(eventType);
    if (kind === 'push') {
      return extractStringPath(p, this.paths.pushSha) ?? 'HEAD';
    }
    if (kind === 'pull_request') {
      const pr = (p.pull_request as Record<string, unknown> | undefined) ?? undefined;
      const head = pr?.head as Record<string, unknown> | undefined;
      if (head && typeof head.sha === 'string') return head.sha;
      const oa = p.object_attributes as Record<string, unknown> | undefined;
      const lastCommit = oa?.last_commit as Record<string, unknown> | undefined;
      if (lastCommit && typeof lastCommit.id === 'string') return lastCommit.id;
    }
    return 'HEAD';
  }

  /**
   * Universal-git sources carry no provider-native auth in the payload —
   * the orchestrator resolves `credentialRef` out-of-band via the secret
   * store. This method therefore returns an empty record.
   */
  extractCredentials(_payload: unknown): Record<string, unknown> {
    return {};
  }

  /**
   * Extension hook used by the processor's `isDefaultBranchPush` check so it
   * does not need to hardcode `payload.repository.default_branch`. The
   * engine interface does not yet declare this method; it is consumed via
   * an optional chain (`normalizer.extractDefaultBranch?.(payload)`), so it
   * is safe to ship ahead of the interface change in Phase 3.
   */
  extractDefaultBranch(payload: unknown): string | null {
    const p = (payload as Record<string, unknown>) ?? {};
    return extractStringPath(p, this.paths.defaultBranch);
  }

  /** Classify the raw event header against the source's eventMapping. */
  private classifyEvent(eventType: string): 'push' | 'pull_request' | null {
    if (this.eventMapping.push.includes(eventType)) return 'push';
    if (this.eventMapping.pullRequest.includes(eventType)) return 'pull_request';
    return null;
  }
}

/**
 * Evaluate a JSONPath expression and return the first match as a string.
 * Returns null if the expression has no matches or the matched value is
 * not a string.
 */
function extractStringPath(payload: Record<string, unknown>, path: string): string | null {
  const results = JSONPath({ path, json: payload, wrap: true }) as unknown[];
  if (results.length === 0) return null;
  const first = results[0];
  return typeof first === 'string' ? first : null;
}

/**
 * Extract a sender/pusher username. Forgejo/Gitea/Gogs expose `sender.login`
 * (same as GitHub); GitLab uses `user_username`.
 */
function extractSenderUsername(payload: Record<string, unknown>): string | undefined {
  const sender = payload.sender as { login?: string } | undefined;
  if (sender?.login) return sender.login;
  if (typeof payload.user_username === 'string') return payload.user_username;
  return undefined;
}

/**
 * Extract the immutable IDP-side numeric id of the sender (mirror of
 * Platform's `identity_links.provider_user_id`). GitHub/Forgejo/Gitea/Gogs
 * place it under `sender.id`; GitLab uses `user_id`. The wire shape varies
 * (number vs string) so we coerce to string for protocol stability.
 *
 * Returns `undefined` when the field is absent, in which case trust
 * resolution falls back to username matching during the backfill window
 * and refuses trust under the strict end-state policy.
 */
function extractSenderUserId(payload: Record<string, unknown>): string | undefined {
  const sender = payload.sender as { id?: unknown } | undefined;
  const fromSender = sender?.id;
  if (typeof fromSender === 'number' && Number.isFinite(fromSender)) return String(fromSender);
  if (typeof fromSender === 'string' && fromSender.length > 0) return fromSender;
  // GitLab push/MR payloads use `user_id`.
  const fromUser = payload.user_id;
  if (typeof fromUser === 'number' && Number.isFinite(fromUser)) return String(fromUser);
  if (typeof fromUser === 'string' && fromUser.length > 0) return fromUser;
  return undefined;
}

/**
 * Extract `full_name` from a PR base/head descriptor. Forgejo/Gitea/Gogs nest
 * it under `repo.full_name`; some GitLab payloads place it at `full_name`
 * directly. Returns undefined when the field is missing.
 */
function extractRepoFullName(side: Record<string, unknown> | undefined): string | undefined {
  if (!side) return undefined;
  const repo = side.repo as { full_name?: string } | undefined;
  if (repo && typeof repo.full_name === 'string') return repo.full_name;
  if (typeof side.full_name === 'string') return side.full_name;
  return undefined;
}
