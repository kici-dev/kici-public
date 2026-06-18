/**
 * Admin API routes for the event DLQ (dead-letter queue).
 *
 * Exposes the orchestrator-side DLQ — events that exhausted their dispatch
 * retry budget — over Bearer-auth HTTP so operators can list, manually retry,
 * or discard rows from the kici-admin CLI / dashboard.
 *
 *   GET    /api/v1/admin/event-dlq        — list DLQ events (limit + cursor)
 *   GET    /api/v1/admin/event-dlq/count  — number of DLQ events (for badge)
 *   POST   /api/v1/admin/event-dlq/:id/retry  — clear DLQ flag, schedule for retry
 *   DELETE /api/v1/admin/event-dlq/:id    — permanently discard a DLQ event
 *
 * The retry path also issues `pg_notify('kici_event_channel', id)` so a
 * healthy node picks the event up immediately rather than waiting for the
 * leader-only retry scanner's next tick.
 *
 * Mutations write an access_log row (event_dlq.retry / event_dlq.discard).
 */
import { Hono } from 'hono';
import { sql } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type { EventStore } from '../events/event-store.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { handleAdminError } from './admin-errors.js';
import { enforceRoutingKeyScope } from '../secrets/routing-key-scope.js';

const logger = createLogger({ prefix: 'admin-event-dlq' });

export interface AdminEventDlqRoutesDeps {
  eventStore: EventStore;
  tokenManager: TokenManager;
  rbac: RbacEnforcer;
  /** Required so retry/discard mutations land in the access log. */
  accessLog?: AccessLogWriter;
}

type AdminEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(raw: string | undefined): number {
  const parsed = parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function parseCursor(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

export function createAdminEventDlqRoutes(deps: AdminEventDlqRoutesDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // ── Bearer token auth middleware ────────────────────────────────
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
  app.use('/api/v1/admin/event-dlq', authMiddleware);
  app.use('/api/v1/admin/event-dlq/*', authMiddleware);

  // ── GET /api/v1/admin/event-dlq — list rows ─────────────────────
  app.get('/api/v1/admin/event-dlq', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'event_dlq.read');

      const limit = clampLimit(c.req.query('limit'));
      const beforeDlqAt = parseCursor(c.req.query('before'));
      const tokenRoutingKey = c.get('routingKey') ?? undefined;

      const events = await deps.eventStore.listDlq(limit, beforeDlqAt, tokenRoutingKey);

      const nextCursor =
        events.length === limit ? (events[events.length - 1].dlqAt?.toISOString() ?? null) : null;

      return c.json(
        {
          events: events.map((e) => ({
            id: e.id,
            eventName: e.eventName,
            payload: e.payload,
            sourceRepo: e.sourceRepo ?? null,
            sourceRoutingKey: e.sourceRoutingKey ?? null,
            sourceRunId: e.sourceRunId ?? null,
            sourceJobId: e.sourceJobId ?? null,
            chainDepth: e.chainDepth,
            createdAt: e.createdAt.toISOString(),
            dlqAt: e.dlqAt?.toISOString() ?? null,
            dlqReason: e.dlqReason,
            attempts: e.attempts,
            lastError: e.lastError,
          })),
          limit,
          nextCursor,
        },
        200,
      );
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // ── GET /api/v1/admin/event-dlq/count — total DLQ depth ────────
  app.get('/api/v1/admin/event-dlq/count', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'event_dlq.read');
      const tokenRoutingKey = c.get('routingKey') ?? undefined;
      const total = await deps.eventStore.countDlq(tokenRoutingKey);
      return c.json({ total }, 200);
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // ── POST /api/v1/admin/event-dlq/:id/retry — retry one event ──
  app.post('/api/v1/admin/event-dlq/:id/retry', async (c) => {
    const id = c.req.param('id');
    try {
      deps.rbac.requirePermission(c.get('role'), 'event_dlq.manage');

      const existing = await deps.eventStore.getById(id);
      if (!existing || !existing.dlqAt) {
        return c.json({ error: 'DLQ event not found' }, 404);
      }
      const denied = enforceRoutingKeyScope(c, existing.sourceRoutingKey ?? null);
      if (denied) return denied;

      const ok = await deps.eventStore.resetFromDlq(id);
      if (!ok) {
        return c.json({ error: 'DLQ event not found' }, 404);
      }

      // Re-publish so a healthy node picks it up immediately rather than
      // waiting for the leader-only retry scanner's next tick. We deliberately
      // issue the notify outside any transaction — the row update above has
      // already committed, so the notify is safe to fire-and-forget.
      try {
        await sql`SELECT pg_notify('kici_event_channel', ${id})`.execute(deps.eventStore.getDb());
      } catch (err) {
        // Notify failure is non-fatal: the retry scanner will pick it up on
        // its next tick. Log so operators see why the row didn't dispatch
        // sooner, but don't fail the API call.
        logger.warn('pg_notify failed after DLQ retry; scanner will catch up', {
          eventId: id,
          error: toErrorMessage(err),
        });
      }

      await deps.accessLog?.record({
        orgId: null,
        routingKey: null,
        actor: { type: 'api_key', keyId: c.get('userId'), ownerSub: c.get('userId') },
        action: 'event_dlq.retry',
        target: { type: 'event_dlq', id },
        requestId: null,
        source: 'admin_http',
        outcome: 'allowed',
      });

      return c.json({ retried: true, id }, 200);
    } catch (err) {
      await deps.accessLog
        ?.record({
          orgId: null,
          routingKey: null,
          actor: { type: 'api_key', keyId: c.get('userId'), ownerSub: c.get('userId') },
          action: 'event_dlq.retry',
          target: { type: 'event_dlq', id },
          requestId: null,
          source: 'admin_http',
          outcome: 'error',
          errorMessage: toErrorMessage(err),
        })
        .catch(() => {
          // Access-log writes are best-effort; never mask the real error.
        });
      return handleAdminError(c, err, logger);
    }
  });

  // ── DELETE /api/v1/admin/event-dlq/:id — discard ──────────────
  app.delete('/api/v1/admin/event-dlq/:id', async (c) => {
    const id = c.req.param('id');
    try {
      deps.rbac.requirePermission(c.get('role'), 'event_dlq.manage');

      const existing = await deps.eventStore.getById(id);
      if (!existing || !existing.dlqAt) {
        return c.json({ error: 'DLQ event not found' }, 404);
      }
      const denied = enforceRoutingKeyScope(c, existing.sourceRoutingKey ?? null);
      if (denied) return denied;

      const ok = await deps.eventStore.deleteDlq(id);
      if (!ok) {
        return c.json({ error: 'DLQ event not found' }, 404);
      }

      await deps.accessLog?.record({
        orgId: null,
        routingKey: null,
        actor: { type: 'api_key', keyId: c.get('userId'), ownerSub: c.get('userId') },
        action: 'event_dlq.discard',
        target: { type: 'event_dlq', id },
        requestId: null,
        source: 'admin_http',
        outcome: 'allowed',
      });

      return c.json({ discarded: true, id }, 200);
    } catch (err) {
      await deps.accessLog
        ?.record({
          orgId: null,
          routingKey: null,
          actor: { type: 'api_key', keyId: c.get('userId'), ownerSub: c.get('userId') },
          action: 'event_dlq.discard',
          target: { type: 'event_dlq', id },
          requestId: null,
          source: 'admin_http',
          outcome: 'error',
          errorMessage: toErrorMessage(err),
        })
        .catch(() => {});
      return handleAdminError(c, err, logger);
    }
  });

  return app;
}
