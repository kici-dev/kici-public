/**
 * Shared Bearer-token auth middleware for the orchestrator's admin routes.
 *
 * One factory serves every DB-backed admin router, which is what makes the
 * error boundary universal: a router that forgets to wrap `validate()` cannot
 * exist, because no router writes that call itself.
 *
 * Three outcomes, deliberately distinct:
 *   - header absent / not `Bearer <token>`   -> 401 AUTH_ERROR.missing
 *   - token unknown / revoked / expired      -> 401 AUTH_ERROR.invalid
 *   - validation could not be completed      -> 503 AUTH_ERROR.unavailable
 *
 * The third is the reason this file exists. `validate()` returns `null` for a
 * bad credential, so it only throws when the lookup itself fails (unreachable
 * DB, exhausted pool, failover). That is not the caller's fault and is not a
 * bug in this request: the server cannot authenticate anyone right now, which
 * is what 503 means. It also keeps a DB blip out of the 5xx error-rate signal
 * that alerting reads as an application outage.
 *
 * The boundary fails closed: an unresolvable auth decision is a rejection with
 * a 5xx, never a fall-through to the protected handler.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Role } from '../secrets/rbac.js';

const defaultLogger = createLogger({ prefix: 'admin-auth' });

/**
 * The three admin-auth response bodies.
 *
 * A single map rather than string literals repeated across every admin router:
 * the 401 wordings are observed by operators and by E2E assertions, so they are
 * pinned in exactly one place.
 */
export const AUTH_ERROR = {
  missing: 'Missing authorization',
  invalid: 'Invalid or expired token',
  unavailable: 'Authentication unavailable',
} as const;

/** What a successful admin-token validation yields. */
export interface AuthTokenInfo {
  id: string;
  role: Role;
  routingKey: string | null;
  label: string;
}

/** The slice of TokenManager this middleware needs (keeps tests trivial to fake). */
export interface AuthTokenValidator {
  validate(token: string): Promise<AuthTokenInfo | null>;
}

/**
 * The result of resolving one `Authorization` header.
 *
 * Failures carry the status and body rather than a `Response` so a caller that
 * is not a middleware (the inline run-cancel route on the coordinator app) can
 * answer with the identical shape.
 */
export type BearerAuthOutcome =
  { ok: true; tokenInfo: AuthTokenInfo } | { ok: false; status: 401 | 503; error: string };

export interface BearerAuthDeps {
  tokenManager: AuthTokenValidator;
  /** Route-family label recorded on the 503 log line (e.g. 'admin-runs'). */
  scope: string;
  /** Overridable for tests; defaults to the module logger. */
  logger?: { error(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Resolve one request's `Authorization` header into an authenticated token or
 * a rejection. This is the boundary itself; the middleware below is a thin
 * wrapper so a route that needs the token info inline can share it.
 *
 * @param c - The request context (only the header, method, and path are read).
 * @param deps - Token validator, a scope label for logs, and an optional logger.
 * @returns The token info, or the status + body to answer with.
 */
export async function resolveBearerAuth(
  c: Context<any>,
  deps: BearerAuthDeps,
): Promise<BearerAuthOutcome> {
  const logger = deps.logger ?? defaultLogger;

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: AUTH_ERROR.missing };
  }
  const token = authHeader.slice(7);

  let tokenInfo: AuthTokenInfo | null;
  try {
    tokenInfo = await deps.tokenManager.validate(token);
  } catch (err) {
    // NEVER include any part of `token` here -- not a prefix, not a hash. The
    // credential contributes nothing to diagnosing a lookup failure, and a
    // prefix is enough to correlate a stolen credential across log stores.
    logger.error('Admin auth validation failed', {
      scope: deps.scope,
      method: c.req.method,
      path: c.req.path,
      error: toErrorMessage(err),
    });
    return { ok: false, status: 503, error: AUTH_ERROR.unavailable };
  }

  if (!tokenInfo) {
    return { ok: false, status: 401, error: AUTH_ERROR.invalid };
  }
  return { ok: true, tokenInfo };
}

/**
 * Build the bearer-auth middleware for one admin route family.
 *
 * @param deps - Token validator, a scope label for logs, and an optional logger.
 * @returns A Hono middleware that authenticates or rejects; it never calls
 *   `next()` on an unresolved credential.
 */
export function createBearerAuthMiddleware(deps: BearerAuthDeps): MiddlewareHandler<any> {
  return async (c, next) => {
    const outcome = await resolveBearerAuth(c, deps);
    if (!outcome.ok) {
      return c.json({ error: outcome.error }, outcome.status);
    }

    c.set('role', outcome.tokenInfo.role);
    c.set('userId', outcome.tokenInfo.id);
    c.set('routingKey', outcome.tokenInfo.routingKey);
    await next();
  };
}
