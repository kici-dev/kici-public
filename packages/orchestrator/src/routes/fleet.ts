/**
 * Fleet log-collection admin routes.
 *
 * GET  /admin/fleet-topology  — enumerate the cluster (no fan-out) for
 *                               `debug-bundle --fleet --list` / `--pick`.
 * POST /admin/fleet-bundle     — drive the recursive fan-out and stream the
 *                               assembled nested ZIP back as an octet-stream.
 *
 * Both are protected by the same Bearer admin-token auth as the other admin
 * routes (token-manager validation).
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { TokenManager } from '../secrets/token-manager.js';
import type { FleetRoutesDeps } from '../app.js';

const logger = createLogger({ prefix: 'fleet-routes' });

export interface FleetAdminRouteDeps {
  fleet: FleetRoutesDeps;
  tokenManager: TokenManager;
}

export function createFleetRoutes(deps: FleetAdminRouteDeps): Hono {
  const app = new Hono();

  // ── Bearer token auth middleware ────────────────────────────────
  // Scoped to the fleet admin paths only. This router is mounted at '/' on
  // the orchestrator app, so a '*' matcher would attach the auth gate to
  // every orchestrator route (including /health, /cluster/health, and the
  // webhook ingress) and 401 them. Mirror the path-scoped pattern used by
  // the main admin router (routes/admin.ts).
  const authMiddleware: MiddlewareHandler = async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization' }, 401);
    }
    const tokenInfo = await deps.tokenManager.validate(authHeader.slice(7));
    if (!tokenInfo) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    await next();
  };
  app.use('/admin/fleet-topology', authMiddleware);
  app.use('/admin/fleet-bundle', authMiddleware);

  // ── GET /admin/fleet-topology — enumerate (no collection) ───────
  app.get('/admin/fleet-topology', (c) => {
    return c.json(deps.fleet.getTopology(), 200);
  });

  // ── POST /admin/fleet-bundle — fan out + stream ZIP ─────────────
  app.post('/admin/fleet-bundle', async (c) => {
    let body: {
      selectors?: unknown;
      logWindowHours?: unknown;
      timeoutSeconds?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const selectors = Array.isArray(body.selectors)
      ? body.selectors.filter((s): s is string => typeof s === 'string')
      : [];
    const logWindowHours =
      typeof body.logWindowHours === 'number' ? body.logWindowHours : undefined;
    const timeoutSeconds =
      typeof body.timeoutSeconds === 'number' ? body.timeoutSeconds : undefined;

    try {
      const buf = await deps.fleet.collectBundle({ selectors, logWindowHours, timeoutSeconds });
      c.header('Content-Type', 'application/zip');
      c.header('Content-Disposition', 'attachment; filename="fleet-bundle.zip"');
      return c.body(buf as unknown as ArrayBuffer, 200);
    } catch (err) {
      logger.error('Fleet bundle collection failed', { error: toErrorMessage(err) });
      return c.json({ error: toErrorMessage(err) }, 500);
    }
  });

  return app;
}
