/**
 * Admin API routes for the access log (access_log table): read and
 * orchestrator-admin mutation attempts with ActorPrincipal attribution.
 * Mirrors the dashboard.access-log.list WS handler over HTTP + Bearer auth, so
 * operators can read it from the CLI.
 *
 *   GET /api/v1/admin/access-log
 *     Filters: orgId, actorType, actorId, action, source, outcome,
 *              targetType, targetId, from, to, q, agentLabel, agentOnly,
 *              limit, cursor
 *     Requires: access_log.read
 *
 *   GET /api/v1/admin/access-log/:id
 *     Requires: access_log.read
 */

import { Hono } from 'hono';
import { createLogger } from '@kici-dev/shared';
import {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogSource,
  AccessLogTargetType,
  ActorType,
} from '@kici-dev/engine';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import { createBearerAuthMiddleware } from './admin-auth.js';
import { type AdminEnv, createAdminApp, requireUnscoped } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-access-log' });

export interface AdminAccessLogRoutesDeps {
  accessLog: AccessLogWriter;
  tokenManager: TokenManager;
  rbac: RbacEnforcer;
}

export function createAdminAccessLogRoutes(deps: AdminAccessLogRoutesDeps): Hono<AdminEnv> {
  const app = createAdminApp(logger);

  const authMiddleware = createBearerAuthMiddleware({
    tokenManager: deps.tokenManager,
    scope: 'admin-access-log',
  });
  app.use('/api/v1/admin/access-log', authMiddleware);
  app.use('/api/v1/admin/access-log/*', authMiddleware);

  // The access log tracks all tenants in one table, so a routing-key-scoped
  // token has no slice it could safely see: refused entirely.
  app.use('/api/v1/admin/access-log', requireUnscoped);
  app.use('/api/v1/admin/access-log/*', requireUnscoped);

  app.get('/api/v1/admin/access-log', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'access_log.read');

    const orgId = c.req.query('orgId');
    const actorTypeRaw = c.req.query('actorType');
    const actorId = c.req.query('actorId');
    const actionRaw = c.req.query('action');
    const sourceRaw = c.req.query('source');
    const outcomeRaw = c.req.query('outcome');
    const targetTypeRaw = c.req.query('targetType');
    const targetId = c.req.query('targetId');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const q = c.req.query('q');
    const agentLabel = c.req.query('agentLabel');
    const agentOnly = c.req.query('agentOnly') === 'true';
    const limitRaw = c.req.query('limit');
    const cursor = c.req.query('cursor');

    const actorType = actorTypeRaw ? ActorType.parse(actorTypeRaw) : undefined;
    const action = actionRaw ? AccessLogAction.parse(actionRaw) : undefined;
    const source = sourceRaw ? AccessLogSource.parse(sourceRaw) : undefined;
    const outcome = outcomeRaw ? AccessLogOutcome.parse(outcomeRaw) : undefined;
    const targetType = targetTypeRaw ? AccessLogTargetType.parse(targetTypeRaw) : undefined;

    const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 50, 1), 200) : 50;

    const { items, nextCursor } = await deps.accessLog.query({
      orgId,
      actorType,
      actorId,
      action,
      source,
      outcome,
      targetType,
      targetId,
      fromTimestamp: from,
      toTimestamp: to,
      q,
      agentLabel,
      agentOnly,
      limit,
      cursor,
    });

    return c.json({ items, nextCursor }, 200);
  });

  app.get('/api/v1/admin/access-log/:id', async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'access_log.read');
    const id = c.req.param('id');
    // `?orgId=` is a tenant-scope hint for the cold-store fallback on an
    // archived row (>30d); an empty value means "no hint", matching the CLI
    // default. Unvalidated: getById trusts it for no auth decision.
    const orgId = c.req.query('orgId') || undefined;
    const item = await deps.accessLog.getById(id, { orgId });
    if (!item) return c.json({ error: 'Access log entry not found' }, 404);
    return c.json(item, 200);
  });

  return app;
}
