/**
 * The Hono env, app factory and routing-key guard every admin route file shares.
 */
import { Hono, type Env, type MiddlewareHandler } from 'hono';
import { toErrorMessage } from '@kici-dev/shared';
import type { Role } from '../secrets/rbac.js';
import { requireUnscopedToken } from '../secrets/routing-key-scope.js';
import { handleAdminError } from './admin-errors.js';

/** Context variables the admin auth middleware sets for every admin route. */
export type AdminEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

type ErrorLogger = { error: (msg: string, meta?: Record<string, unknown>) => void };

/**
 * Build an admin sub-app whose thrown errors map through `handleAdminError`.
 *
 * Hono runs a routed sub-app's own error handler, so the parent app's generic
 * 500 never answers an admin route. An `HTTPException` (Hono's deliberate
 * control-flow response) passes through unchanged, as it does on the parent.
 *
 * @param logger - Receives the unmapped-error log line.
 * @param opts.logBeforeHandling - When set, every error is first logged under this message.
 */
export function createAdminApp<E extends Env = AdminEnv>(
  logger: ErrorLogger,
  opts: { logBeforeHandling?: string } = {},
): Hono<E> {
  const app = new Hono<E>();
  app.onError((err, c) => {
    if ('getResponse' in err) {
      const res = err.getResponse();
      return c.newResponse(res.body, res);
    }
    if (opts.logBeforeHandling) {
      logger.error(opts.logBeforeHandling, { error: toErrorMessage(err) });
    }
    return handleAdminError(c, err, logger);
  });
  return app;
}

/** Refuse a routing-key-scoped token with 403 before the handler runs. */
export const requireUnscoped: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const denied = requireUnscopedToken(c);
  if (denied) return denied;
  await next();
};
