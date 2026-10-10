/**
 * Caller identity for orchestrator HTTP routes that act on behalf of the
 * person or tool presenting a credential.
 *
 * Today the one credential is an admin token, resolved through the shared
 * bearer-auth boundary (`resolveBearerAuth`), so the 401 / 503 semantics are
 * identical to every admin route. The caller is a tagged union so a later
 * credential kind (a signed command, for one) joins as another variant without
 * touching the routes that consume it.
 */
import type { Context } from 'hono';
import { ActorType, type ActorPrincipal } from '@kici-dev/engine';
import { resolveBearerAuth, type BearerAuthDeps } from './admin-auth.js';
import { UNSCOPED_REQUIRED_MESSAGE } from '../secrets/routing-key-scope.js';
import type { Role } from '../secrets/rbac.js';

/** A caller authenticated by an admin token. */
export interface TokenCaller {
  kind: 'token';
  tokenId: string;
  label: string;
  /** The intended holder recorded at `token create --subject`, or null. */
  subject: string | null;
  role: Role;
  /** The single routing key a scoped token is restricted to, or null. */
  routingKeyScope: string | null;
}

export type CallerOutcome =
  { ok: true; caller: TokenCaller } | { ok: false; status: 401 | 403 | 503; error: string };

/**
 * Resolve the request's caller.
 *
 * @param c - The request context (the `Authorization` header is read).
 * @param deps - The token validator and log scope, as for `resolveBearerAuth`.
 * @param opts.requireUnscoped - Refuse a routing-key-scoped token with 403.
 *   Routes whose routing key the server chooses set it: a scoped token has no
 *   key of its own to compare there, so accepting it would widen its reach.
 * @returns The caller, or the status and body to answer with.
 */
export async function resolveCaller(
  c: Context<any>,
  deps: BearerAuthDeps,
  opts: { requireUnscoped: boolean },
): Promise<CallerOutcome> {
  const outcome = await resolveBearerAuth(c, deps);
  if (!outcome.ok) return outcome;
  const { tokenInfo } = outcome;
  if (opts.requireUnscoped && tokenInfo.routingKey !== null) {
    return { ok: false, status: 403, error: UNSCOPED_REQUIRED_MESSAGE };
  }
  return {
    ok: true,
    caller: {
      kind: 'token',
      tokenId: tokenInfo.id,
      label: tokenInfo.label,
      subject: tokenInfo.subject ?? null,
      role: tokenInfo.role,
      routingKeyScope: tokenInfo.routingKey,
    },
  };
}

/**
 * The principal a caller's actions are attributed to: a `service_account`
 * bearing the admin token id, the same shape the admin held-run routes use.
 */
export function callerActor(caller: TokenCaller): ActorPrincipal {
  return { type: ActorType.enum.service_account, id: caller.tokenId };
}
