/**
 * Shared Bearer-token auth middleware for the orchestrator's admin routes.
 *
 * One factory serves every DB-backed admin router, so the error boundary is
 * universal: no router calls `validate()` itself, so none can forget to wrap it.
 *
 * Deliberately distinct outcomes:
 *   - header absent / not `Bearer <token>`   -> 401 AUTH_ERROR.missing
 *   - token unknown / revoked / expired      -> 401 AUTH_ERROR.invalid
 *   - validation could not be completed      -> 503 AUTH_ERROR.unavailable
 *
 * `validate()` returns `null` for a bad credential, so it throws only when the
 * lookup fails (unreachable DB, exhausted pool, failover): not the caller's
 * fault, the server cannot authenticate anyone right now — 503. That also keeps
 * a DB blip out of the 5xx error-rate signal alerting reads as an outage.
 *
 * Fails closed: an unresolvable auth decision is a rejection, never a
 * fall-through to the protected handler.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { Role } from '../secrets/rbac.js';

const defaultLogger = createLogger({ prefix: 'admin-auth' });

/**
 * Admin-auth response bodies, pinned in one place: operators observe the 401
 * wordings and tests assert on them.
 */
export const AUTH_ERROR = {
  missing: 'Missing authorization',
  invalid: 'Invalid or expired token',
  unavailable: 'Authentication unavailable',
} as const;

export interface AuthTokenInfo {
  id: string;
  role: Role;
  routingKey: string | null;
  label: string;
  /** The intended holder recorded at `token create --subject`, when one was. */
  subject?: string | null;
}

/** The TokenManager slice this middleware needs (keeps tests trivial to fake). */
export interface AuthTokenValidator {
  validate(token: string): Promise<AuthTokenInfo | null>;
}

/**
 * Failures carry status and body, not a `Response`, so a non-middleware caller
 * (the inline run-cancel route on the coordinator app) answers with the same shape.
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
 * The auth boundary itself; the middleware below is a thin wrapper, so a route
 * that needs the token info inline shares it. Reads only the header, method and path.
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
    // NEVER log any part of `token` -- not a prefix, not a hash: it does not help
    // diagnose a lookup failure, and a prefix correlates a stolen credential
    // across log stores.
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

/** Bearer-auth middleware for one admin route family; never `next()`s an unresolved credential. */
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
