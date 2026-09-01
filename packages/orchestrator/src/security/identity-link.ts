/**
 * Identity-link lookup: map a provider identity from a webhook event onto the
 * KiCI user the Platform linked it to.
 *
 * The comment-approval path uses this to decide whether a `/kici approve`
 * commenter is a linked member with a high enough `ci_trust` level.
 */

import { createLogger } from '@kici-dev/shared';
import type { CiTrustLevel } from '@kici-dev/engine';
import { trustMatchRefusedNoIdTotal } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'identity-link' });

/**
 * RBAC permission levels from the Platform permission system.
 *
 * The same four values the wire schema carries for `memberCiTrustLevels`, so
 * this aliases {@link CiTrustLevel} rather than restating them — a member's CI
 * trust level IS the permission level this module's callers compare against.
 */
export type PermissionLevel = CiTrustLevel;

/** Identity link mapping a provider identity to a KiCI user. */
export interface IdentityLink {
  userId: string;
  provider: string;
  providerUsername: string;
  /**
   * Immutable IDP-side numeric id (e.g. GitHub's `sender.id`). The only field
   * a link is matched on; a link that carries no id can never match, so it
   * grants nothing.
   */
  providerUserId?: string | null;
}

/**
 * The provider username the org's identity directory links a KiCI user id to,
 * or undefined when it names none unambiguously.
 *
 * The reverse of {@link findIdentityLink}: that maps a provider identity onto a
 * KiCI user, this maps a KiCI user back onto a name a human recognises. Used
 * where a decision made in the dashboard / CLI / MCP — which carries only the
 * actor's opaque subject id — has to be attributed in copy a contributor reads
 * on a public commit check.
 *
 * A user may hold links on several providers. When they agree on the username
 * the answer is unambiguous; when they disagree there is no way to tell here
 * which provider serves the commit, so this answers undefined rather than
 * naming the wrong account. Undefined is a safe answer at every call site: the
 * attribution is simply omitted, never replaced by the raw subject id.
 */
export function resolveLinkedUsername(
  identityLinks: IdentityLink[],
  userId: string,
): string | undefined {
  const names = new Set(
    identityLinks.filter((link) => link.userId === userId).map((link) => link.providerUsername),
  );
  return names.size === 1 ? [...names][0] : undefined;
}

/**
 * Match an identity link strictly by `(provider, providerUserId)`.
 *
 * Returns `null` whenever the numeric id is missing on either side or when no
 * link's id matches the event's id. Matching by username is not supported, so
 * renaming a provider account cannot be used to impersonate a linked member.
 * A refused match is recorded under
 * `kici_orch_trust_match_refused_no_id_total{reason}` so the rate of refusals
 * stays observable.
 *
 * Pre-condition for callers: the Platform has filled `provider_user_id` for
 * every row it pushes in `identity_links` — a row without one is inert here.
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
  // metrics — it is NOT used to grant a match.
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
