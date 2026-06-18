/**
 * Helpers for enforcing the `routing_key` scope on admin tokens.
 *
 * `admin_tokens.routing_key` is an optional column. A token created with
 * `kici-admin token create --routing-key <key>` is restricted to operations
 * that target that exact routing key:
 *
 *   - Routes that take an explicit routing key (URL param, query param, or
 *     request body) MUST gate access with `enforceRoutingKeyScope`. Routes
 *     that target an entity by ID look up the row's `routing_key` column
 *     first and pass that to `enforceRoutingKeyScope`.
 *   - Routes that target an org or that operate orchestrator-wide (no
 *     routing-key concept at all) MUST refuse routing-key tokens via
 *     `requireUnscopedToken`.
 *
 * Both helpers return a Hono `Response` to short-circuit the handler when
 * access is denied, or `null` to let the handler continue. The middleware
 * mounted in each admin route file is responsible for calling
 * `c.set('routingKey', tokenInfo.routingKey)` so these helpers can read it.
 */

import type { Context } from 'hono';

const ACCESS_DENIED_MESSAGE =
  'Access denied: token is restricted to a single routing key and this request targets a different one';

const UNSCOPED_REQUIRED_MESSAGE =
  'Access denied: this route requires an unscoped admin token (the calling token is restricted to a single routing key)';

/**
 * Read the calling token's routing-key scope from the Hono context.
 *
 * Returns the scope string when the token was created with
 * `--routing-key <key>`, or `null` when the token has full orchestrator
 * access (no scope) or when the auth middleware did not populate the
 * variable.
 */
function getTokenRoutingKey(c: Context): string | null {
  const value = c.get('routingKey' as never);
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

/**
 * Reject the request with 403 when the calling token has a routing-key
 * scope and the request targets a different routing key.
 *
 * Pass `requested = null | undefined` for routes that explicitly do not
 * carry a routing key — in that case the call is also rejected for
 * scoped tokens. Use {@link requireUnscopedToken} when the route is
 * orchestrator-wide or org-scoped (no per-routing-key variant exists at
 * all) to make the intent explicit.
 *
 * Returns a `Response` to short-circuit the handler when access is
 * denied, or `null` to let the handler continue.
 */
export function enforceRoutingKeyScope(
  c: Context,
  requested: string | null | undefined,
): Response | null {
  const tokenRoutingKey = getTokenRoutingKey(c);
  if (tokenRoutingKey === null) return null;
  if (typeof requested === 'string' && requested.length > 0 && requested === tokenRoutingKey) {
    return null;
  }
  return c.json({ error: ACCESS_DENIED_MESSAGE }, 403);
}

/**
 * Reject the request with 403 when the calling token has any routing-key
 * scope. Use this on routes that operate on orchestrator-wide state,
 * org-level state, or any other surface where the routing-key concept
 * does not apply.
 */
export function requireUnscopedToken(c: Context): Response | null {
  const tokenRoutingKey = getTokenRoutingKey(c);
  if (tokenRoutingKey === null) return null;
  return c.json({ error: UNSCOPED_REQUIRED_MESSAGE }, 403);
}
