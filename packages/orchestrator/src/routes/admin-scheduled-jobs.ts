/**
 * Admin route for triggering scheduled-job ticks out of band.
 *
 *   POST /api/v1/admin/scheduled-jobs/:name/trigger
 *     Path: :name must be one of the registered OrchestratorScheduledJobName
 *     Requires: scheduled_job.trigger role permission (owner + admin roles)
 *     Returns: { triggered: true, ok: boolean, durationMs: number, error?: string }
 *
 * Phase A's E2E smoke uses this endpoint to force a cold-store-archive
 * tick without waiting for the hourly cron. Future dashboard "Run now"
 * buttons use it too.
 *
 * The access_log row is written directly (not via the typed
 * AccessLogWriter) because `scheduled_job.trigger` is not in the
 * protocol-level AccessLogAction enum — matching the pattern the
 * scheduler wrapper itself uses for `scheduled_job.tick` failure rows.
 */

import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import {
  ACCESS_LOG_ACTION_TRIGGER,
  OrchestratorScheduledJobName,
  findOrchestratorScheduledJob,
} from '../queue/scheduled-job.js';
import { requireUnscopedToken } from '../secrets/routing-key-scope.js';

const logger = createLogger({ prefix: 'admin-scheduled-jobs' });

export interface AdminScheduledJobsRoutesDeps {
  db: Kysely<Database>;
  tokenManager: TokenManager;
  rbac: RbacEnforcer;
}

type AdminEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

export function createAdminScheduledJobsRoutes(deps: AdminScheduledJobsRoutesDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  const authMiddleware = async (c: any, next: any) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization' }, 401);
    }
    const token = authHeader.slice(7);
    const tokenInfo = await deps.tokenManager.validate(token);
    if (!tokenInfo) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    c.set('role', tokenInfo.role);
    c.set('userId', tokenInfo.id);
    c.set('routingKey', tokenInfo.routingKey);
    await next();
  };
  app.use('/api/v1/admin/scheduled-jobs/*', authMiddleware);

  app.post('/api/v1/admin/scheduled-jobs/:name/trigger', async (c) => {
    const denied = requireUnscopedToken(c);
    if (denied) return denied;
    try {
      deps.rbac.requirePermission(c.get('role'), 'scheduled_job.trigger');
    } catch (err) {
      return c.json({ error: String(err) }, 403);
    }

    const rawName = c.req.param('name');
    const parsed = OrchestratorScheduledJobName.safeParse(rawName);
    if (!parsed.success) {
      return c.json({ error: `Unknown scheduled job: ${rawName}` }, 400);
    }
    const name = parsed.data;

    const handle = findOrchestratorScheduledJob(name);
    if (!handle) {
      return c.json({ error: `Scheduled job is not registered on this instance: ${name}` }, 404);
    }

    const actorId = c.get('userId');
    logger.info('Admin-triggered scheduled job tick', { name, actor: actorId });

    // Best-effort audit row. Uses raw insert because the action string
    // is not in the protocol AccessLogAction enum — same pattern as
    // the tick-failure audit in the scheduler wrapper.
    void deps.db
      .insertInto('access_log')
      .values({
        org_id: null,
        routing_key: null,
        actor_type: 'user',
        actor_id: actorId,
        actor_meta: null,
        action: ACCESS_LOG_ACTION_TRIGGER,
        target_type: 'scheduled_job',
        target_id: name,
        request_id: null,
        source: 'admin_http',
        outcome: 'allowed',
        error_message: null,
      })
      .execute()
      .catch((err) => {
        logger.error('Failed to record access_log for scheduled-job trigger', {
          name,
          error: String(err),
        });
      });

    const result = await handle.triggerNow();
    return c.json({
      triggered: true,
      ok: result.ok,
      durationMs: result.durationMs,
      error: result.error,
    });
  });

  return app;
}
