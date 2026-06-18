/**
 * TrustResolver -- combines identity links, RBAC ci_trust, and provider permissions
 * into a trust tier decision.
 *
 * The TrustResolver is the core decision engine for CI security. It determines
 * whether a contributor is trusted, known, or unknown based on:
 * 1. Identity link lookup (provider username -> KiCI user ID)
 * 2. ci_trust RBAC level for that user in the org
 * 3. Provider API permission (via ContributorResolver + cache)
 */

import type { ContributorPermission, ContributorResolver } from '@kici-dev/engine';
import type { TrustTier } from '@kici-dev/engine';
import { createLogger } from '@kici-dev/shared';
import type { ContributorCache } from './contributor-cache.js';
import { trustMatchRefusedNoIdTotal } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'trust-resolver' });

/**
 * Match an identity link strictly by `(provider, providerUserId)`.
 *
 * Returns `null` whenever the numeric id is missing on either side or when no
 * link's id matches the event's id. This is the strict end-state contract:
 * username fallback is gone, mutable-username impersonation cannot grant
 * trust, and a refused match is recorded under
 * `kici_orch_trust_match_refused_no_id_total{reason}` so the rate of refusals
 * stays observable.
 *
 * Pre-conditions for callers: Platform's reconcile job has filled
 * `provider_user_id` for every row in `identity_links` (verified by the
 * `kici_platform_identity_links_missing_provider_user_id` gauge being 0 for
 * ≥4 cycles before this strict policy was deployed). See
 * `.claude/plans/cryptic-jumping-narwhal.md` for the rollout journey.
 */
export function findIdentityLink(
  identityLinks: IdentityLink[],
  provider: string,
  providerUsername: string,
  providerUserId: string | undefined,
): IdentityLink | null {
  if (providerUserId === undefined || providerUserId.length === 0) {
    trustMatchRefusedNoIdTotal.add(1, { reason: 'event_missing' });
    logger.warn('Trust match refused: webhook event has no provider numeric id', {
      provider,
      providerUsername,
    });
    return null;
  }

  const byId = identityLinks.find(
    (link) =>
      link.provider === provider &&
      link.providerUserId !== null &&
      link.providerUserId !== undefined &&
      link.providerUserId === providerUserId,
  );
  if (byId) return byId;

  // Inspect the username-matched link only to classify the refusal reason for
  // metrics — it is NOT used to grant trust. This is the strict policy.
  const byUsername = identityLinks.find(
    (link) => link.provider === provider && link.providerUsername === providerUsername,
  );
  if (byUsername) {
    const reason =
      byUsername.providerUserId === null || byUsername.providerUserId === undefined
        ? 'link_missing'
        : 'id_mismatch';
    trustMatchRefusedNoIdTotal.add(1, { reason });
    logger.warn('Trust match refused: numeric id missing on link or did not match event', {
      provider,
      providerUsername,
      providerUserId,
      linkProviderUserId: byUsername.providerUserId ?? null,
      reason,
    });
  }
  return null;
}

/** RBAC permission levels from the Platform permission system. */
export type PermissionLevel = 'none' | 'read' | 'write' | 'admin';

/** Identity link mapping a provider identity to a KiCI user. */
export interface IdentityLink {
  userId: string;
  provider: string;
  providerUsername: string;
  /**
   * Immutable IDP-side numeric id (e.g. GitHub's `sender.id`).
   * Nullable during the backfill window for legacy rows that
   * predate Platform migration 009. Trust resolver matches on
   * this field first; once backfill completes the strict policy
   * refuses trust when this is null.
   */
  providerUserId?: string | null;
}

/** Parameters for trust tier resolution. */
interface TrustResolutionParams {
  /** Sender username from the webhook event. */
  providerUsername: string;
  /**
   * Sender immutable IDP-side numeric id from the webhook event (e.g.
   * GitHub's `sender.id` coerced to string). Optional during the backfill
   * window; the strict end-state refuses trust when this is missing.
   */
  providerUserId?: string;
  /** Provider type (e.g. 'github'). */
  provider: string;
  /** Repository identifier (e.g. 'owner/repo'). */
  repoIdentifier: string;
  /** Whether the PR comes from a fork. */
  isForkPR: boolean;
  /** Organization ID this webhook routes to. */
  orgId: string;
  /** Cached identity links from Platform push. */
  identityLinks: IdentityLink[];
  /** ci_trust permission levels per user ID from Platform push. */
  orgMemberPermissions: Map<string, PermissionLevel>;
  /** Provider-specific contributor resolver. */
  contributorResolver: ContributorResolver;
  /** Credentials for provider API calls. */
  credentials: unknown;
}

/** Result of trust tier resolution with full audit trail. */
export interface TrustResolution {
  tier: TrustTier;
  contributorUsername: string;
  identityLinked: boolean;
  userId?: string;
  providerPermission: ContributorPermission;
  ciTrustLevel?: PermissionLevel;
  reason: string;
}

/**
 * Whether a permission level grants write-or-higher access.
 */
function isWriteOrHigher(permission: ContributorPermission): boolean {
  return permission === 'write' || permission === 'admin';
}

/**
 * Whether a permission level is read or higher (any repo access).
 */
function isReadOrHigher(permission: ContributorPermission): boolean {
  return permission === 'read' || permission === 'write' || permission === 'admin';
}

/**
 * Whether a ci_trust RBAC level is write or higher.
 */
function isCiTrustWriteOrHigher(level: PermissionLevel): boolean {
  return level === 'write' || level === 'admin';
}

/**
 * TrustResolver combines identity links, ci_trust RBAC, and provider permissions
 * into a trust tier.
 *
 * Decision matrix:
 * 1. Fork PR -> always unknown
 * 2. No identity link -> provider API fallback (never trusted)
 *    - read+ -> known
 *    - none -> unknown
 * 3. Identity linked -> combine ci_trust + provider permission:
 *    - provider write+ AND ci_trust write+ -> trusted
 *    - provider write+ AND ci_trust none/read -> known
 *    - provider read -> known
 *    - provider none -> unknown
 */
export class TrustResolver {
  constructor(private readonly contributorCache: ContributorCache) {}

  /**
   * Resolve the trust tier for a contributor.
   */
  async resolveTrustTier(params: TrustResolutionParams): Promise<TrustResolution> {
    const {
      providerUsername,
      providerUserId,
      provider,
      repoIdentifier,
      isForkPR,
      identityLinks,
      credentials,
    } = params;

    // 1. Fork PRs are always unknown
    if (isForkPR) {
      // Still resolve provider permission for audit trail
      const info = await this.contributorCache.resolve(
        provider,
        repoIdentifier,
        providerUsername,
        params.contributorResolver,
        credentials,
      );

      return {
        tier: 'unknown',
        contributorUsername: providerUsername,
        identityLinked: false,
        providerPermission: info.permission,
        reason: 'Fork PR -- all fork PRs resolve to unknown regardless of contributor identity',
      };
    }

    // 2. Look up identity link (numeric-id-first, username fallback)
    const identityLink = findIdentityLink(
      identityLinks,
      provider,
      providerUsername,
      providerUserId,
    );

    // Resolve provider permission via cache
    const info = await this.contributorCache.resolve(
      provider,
      repoIdentifier,
      providerUsername,
      params.contributorResolver,
      credentials,
    );

    // 3. No identity link -> provider API fallback (never trusted)
    if (!identityLink) {
      if (isReadOrHigher(info.permission)) {
        return {
          tier: 'known',
          contributorUsername: providerUsername,
          identityLinked: false,
          providerPermission: info.permission,
          reason: `No identity link, but provider shows ${info.permission} access -- resolves to known`,
        };
      }

      return {
        tier: 'unknown',
        contributorUsername: providerUsername,
        identityLinked: false,
        providerPermission: info.permission,
        reason: 'No identity link and no provider access -- resolves to unknown',
      };
    }

    // 4. Identity linked -> combine ci_trust + provider permission
    const { userId } = identityLink;
    const ciTrustLevel = params.orgMemberPermissions.get(userId) ?? 'none';

    // Provider none -> unknown (regardless of ci_trust)
    if (info.permission === 'none') {
      return {
        tier: 'unknown',
        contributorUsername: providerUsername,
        identityLinked: true,
        userId,
        providerPermission: info.permission,
        ciTrustLevel,
        reason: `Identity linked (user ${userId}), but provider shows no access -- resolves to unknown`,
      };
    }

    // Provider read -> always known (regardless of ci_trust)
    if (info.permission === 'read') {
      return {
        tier: 'known',
        contributorUsername: providerUsername,
        identityLinked: true,
        userId,
        providerPermission: info.permission,
        ciTrustLevel,
        reason: `Identity linked (user ${userId}), provider read access -- resolves to known`,
      };
    }

    // Provider write/admin
    if (isWriteOrHigher(info.permission)) {
      if (isCiTrustWriteOrHigher(ciTrustLevel)) {
        return {
          tier: 'trusted',
          contributorUsername: providerUsername,
          identityLinked: true,
          userId,
          providerPermission: info.permission,
          ciTrustLevel,
          reason: `Identity linked (user ${userId}), provider ${info.permission} + ci_trust ${ciTrustLevel} -- resolves to trusted`,
        };
      }

      return {
        tier: 'known',
        contributorUsername: providerUsername,
        identityLinked: true,
        userId,
        providerPermission: info.permission,
        ciTrustLevel,
        reason: `Identity linked (user ${userId}), provider ${info.permission} but ci_trust ${ciTrustLevel} -- resolves to known`,
      };
    }

    // Fallback (shouldn't reach here)
    return {
      tier: 'unknown',
      contributorUsername: providerUsername,
      identityLinked: !!identityLink,
      userId,
      providerPermission: info.permission,
      ciTrustLevel,
      reason: `Unexpected permission combination: provider=${info.permission}, ci_trust=${ciTrustLevel}`,
    };
  }
}
