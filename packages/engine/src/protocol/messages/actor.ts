import { z } from 'zod';

/**
 * Typed actor principal for attributable reads, writes, and admin operations
 * across the Platform → orchestrator and orchestrator → agent boundaries.
 *
 * Every dashboard.* / run.* proxy message carries an `actor` field so the
 * orchestrator can write an `access_log` row attributable to a specific
 * principal. The discriminated union prevents string-shape drift between
 * tiers and encodes the reason for break-glass operator access at the
 * protocol level rather than in free-text metadata.
 */

export const ActorType = z.enum([
  'user',
  'api_key',
  'service_account',
  'platform_operator',
  'system',
]);
export type ActorType = z.infer<typeof ActorType>;

export const userActorSchema = z.object({
  type: z.literal(ActorType.enum.user),
  /** Keycloak subject (idp_sub). */
  sub: z.string().min(1),
});
export type UserActor = z.infer<typeof userActorSchema>;

export const apiKeyActorSchema = z.object({
  type: z.literal(ActorType.enum.api_key),
  /** Opaque key identifier (not the secret). */
  keyId: z.string().min(1),
  /** Keycloak sub of the human who owns this key. */
  ownerSub: z.string().min(1),
});
export type ApiKeyActor = z.infer<typeof apiKeyActorSchema>;

export const serviceAccountActorSchema = z.object({
  type: z.literal(ActorType.enum.service_account),
  /** Service-account identifier (orchestrator admin tokens, CI bot tokens, etc.). */
  id: z.string().min(1),
});
export type ServiceAccountActor = z.infer<typeof serviceAccountActorSchema>;

export const platformOperatorActorSchema = z.object({
  type: z.literal(ActorType.enum.platform_operator),
  /** Keycloak sub of the SaaS operator performing break-glass access. */
  sub: z.string().min(1),
  /**
   * Free-text justification recorded in `access_log.actor_meta.reason`.
   * Length bounds reject empty / obviously-bad-faith values; not a ticket
   * pattern (we support multiple incident systems).
   */
  reason: z.string().min(4).max(200),
  /**
   * Support-session id, when the operator is reading through a dashboard
   * support session (not the kici-platform-admin CLI break-glass path).
   * Recorded in `access_log.actor_meta.sessionId` so the customer's activity
   * page can tie each operator read back to the session that authorised it.
   */
  sessionId: z.string().min(1).optional(),
});
export type PlatformOperatorActor = z.infer<typeof platformOperatorActorSchema>;

export const systemActorSchema = z.object({
  type: z.literal(ActorType.enum.system),
  /** Subsystem initiating the action (e.g. 'scheduler', 'retry', 'cleanup'). */
  component: z.string().min(1),
});
export type SystemActor = z.infer<typeof systemActorSchema>;

export const actorPrincipalSchema = z.discriminatedUnion('type', [
  userActorSchema,
  apiKeyActorSchema,
  serviceAccountActorSchema,
  platformOperatorActorSchema,
  systemActorSchema,
]);
export type ActorPrincipal = z.infer<typeof actorPrincipalSchema>;

/**
 * Convert an ActorPrincipal to a colon-prefixed string suitable for DB
 * persistence in columns like `execution_runs.triggered_by` / `.cancelled_by`.
 * The inverse of parseActor().
 *
 * Format: `${type}:${id}` where id is the variant's natural identifier.
 * Extra metadata (api_key.ownerSub, platform_operator.reason) is NOT
 * round-tripped through the string form — callers that need full fidelity
 * must persist the actor object separately (e.g. in `access_log.actor_meta`).
 */
export function stringifyActor(actor: ActorPrincipal): string {
  switch (actor.type) {
    case 'user':
      return `user:${actor.sub}`;
    case 'api_key':
      return `api_key:${actor.keyId}`;
    case 'service_account':
      return `service_account:${actor.id}`;
    case 'platform_operator':
      return `platform_operator:${actor.sub}`;
    case 'system':
      return `system:${actor.component}`;
  }
}

/**
 * Parse a `${type}:${id}` string back into a partial ActorPrincipal.
 * Because the string form drops metadata, api_key.ownerSub and
 * platform_operator.reason are null when the source is a string.
 *
 * Returns null for unrecognized inputs; callers that need strict parsing
 * should throw on null.
 */
export function parseActor(
  value: string | null | undefined,
): { type: ActorType; id: string } | null {
  if (value == null || value === '') return null;
  const idx = value.indexOf(':');
  if (idx < 1 || idx === value.length - 1) return null;
  const prefix = value.slice(0, idx);
  const id = value.slice(idx + 1);
  const parsed = ActorType.safeParse(prefix);
  if (!parsed.success) return null;
  return { type: parsed.data, id };
}

/**
 * Flatten an ActorPrincipal into the three columns the orchestrator
 * `access_log` table uses: (actor_type, actor_id, actor_meta).
 * actor_meta preserves the variant-specific extras that are lost in
 * stringifyActor().
 */
export function flattenActor(actor: ActorPrincipal): {
  actorType: ActorType;
  actorId: string;
  actorMeta: Record<string, unknown> | null;
} {
  switch (actor.type) {
    case 'user':
      return { actorType: 'user', actorId: actor.sub, actorMeta: null };
    case 'api_key':
      return {
        actorType: 'api_key',
        actorId: actor.keyId,
        actorMeta: { ownerSub: actor.ownerSub },
      };
    case 'service_account':
      return { actorType: 'service_account', actorId: actor.id, actorMeta: null };
    case 'platform_operator':
      return {
        actorType: 'platform_operator',
        actorId: actor.sub,
        actorMeta: {
          reason: actor.reason,
          ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
        },
      };
    case 'system':
      return { actorType: 'system', actorId: actor.component, actorMeta: null };
  }
}
