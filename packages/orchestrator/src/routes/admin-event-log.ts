/**
 * Admin API routes for the inbound webhook delivery log (event_log table).
 *
 * Operator-facing read access to the per-delivery records the orchestrator
 * persists for every inbound webhook. Mirrors the dashboard's WS handler
 * (`DashboardHandler.handleEventLogList/Detail`) but is exposed over HTTP +
 * Bearer auth so operators can dogfood from the CLI without going through
 * the dashboard.
 *
 *   GET /api/v1/admin/event-log
 *     Filters: orgId, routingKey, event, status, from, to, deliveryId, limit, offset
 *     Requires: event_log.read
 *
 *   GET /api/v1/admin/event-log/:deliveryId
 *     Query: orgId (required), includePayload (default false)
 *     Requires: event_log.read
 *     The `includePayload` flag additionally requires event_log.read_payload.
 */

import { Hono } from 'hono';
import { gunzipSync } from 'node:zlib';
import { createLogger, toErrorMessage, type ColdStore } from '@kici-dev/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import type { LogStorage } from '../reporting/log-storage.js';
import { loadEventLogRange, loadEventLogByDeliveryId } from '../cold-store/load-event-log-range.js';
import { handleAdminError } from './admin-errors.js';
import { enforceRoutingKeyScope } from '../secrets/routing-key-scope.js';

const logger = createLogger({ prefix: 'admin-event-log' });

export interface AdminEventLogRoutesDeps {
  db: Kysely<Database>;
  logStorage: LogStorage;
  tokenManager: TokenManager;
  rbac: RbacEnforcer;
  /** Phase E: optional cold-store for archived event_log rows. */
  coldStore?: ColdStore;
}

type AdminEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

export function createAdminEventLogRoutes(deps: AdminEventLogRoutesDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // ── Auth middleware ────────────────────────────────────────────
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
  app.use('/api/v1/admin/event-log', authMiddleware);
  app.use('/api/v1/admin/event-log/*', authMiddleware);

  // ── GET /api/v1/admin/event-log — list deliveries ──────────────
  app.get('/api/v1/admin/event-log', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'event_log.read');

      const orgId = c.req.query('orgId');
      const queryRoutingKey = c.req.query('routingKey');
      const tokenRoutingKey = c.get('routingKey');
      // Routing-key-scoped tokens see only their own routing key.
      if (tokenRoutingKey && queryRoutingKey && queryRoutingKey !== tokenRoutingKey) {
        const denied = enforceRoutingKeyScope(c, queryRoutingKey);
        if (denied) return denied;
      }
      const routingKey = tokenRoutingKey ?? queryRoutingKey;
      const event = c.req.query('event');
      const action = c.req.query('action');
      const status = c.req.query('status');
      const from = c.req.query('from');
      const to = c.req.query('to');
      const deliveryId = c.req.query('deliveryId');
      const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);
      const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;
      const includeArchived = c.req.query('includeArchived') === 'true';

      // Cold-store list (Phase E) requires a routing_key to scope the
      // tenant-partitioned scan. When `includeArchived=true` and
      // `routingKey` is supplied, the loader merges hot + cold rows;
      // otherwise the hot-only path runs (preserving the pre-Phase-E
      // count-and-page contract that callers without routing_key rely on).
      let rows: Awaited<ReturnType<typeof loadEventLogRange>>;
      let total: number;
      if (includeArchived && routingKey) {
        rows = await loadEventLogRange({
          db: deps.db,
          coldStore: deps.coldStore,
          routingKey,
          orgId,
          event,
          action,
          status,
          deliveryId,
          fromTs: from ? new Date(from) : undefined,
          toTs: to ? new Date(to) : undefined,
          limit,
          offset,
          includeArchived: true,
        });
        // Count is best-effort: hot count + cold count in the same range.
        let countQuery = deps.db
          .selectFrom('event_log')
          .select(deps.db.fn.countAll<number>().as('total'))
          .where('routing_key', '=', routingKey);
        if (orgId) countQuery = countQuery.where('org_id', '=', orgId);
        if (event) countQuery = countQuery.where('event', '=', event);
        if (action) countQuery = countQuery.where('action', '=', action);
        if (status) countQuery = countQuery.where('status', '=', status);
        if (deliveryId) countQuery = countQuery.where('delivery_id', 'like', `%${deliveryId}%`);
        if (from) countQuery = countQuery.where('received_at', '>=', new Date(from));
        if (to) countQuery = countQuery.where('received_at', '<', new Date(to));
        const hotTotal = Number((await countQuery.executeTakeFirstOrThrow()).total);
        const coldTotal = deps.coldStore
          ? await deps.coldStore.countRange({
              db: 'orchestrator',
              table: 'event_log',
              tenantId: routingKey,
              fromTs: from ? new Date(from) : new Date(0),
              toTs: to ? new Date(to) : new Date(),
            })
          : 0;
        total = hotTotal + coldTotal;
      } else {
        let query = deps.db.selectFrom('event_log').selectAll();

        if (orgId) query = query.where('org_id', '=', orgId);
        if (routingKey) query = query.where('routing_key', '=', routingKey);
        if (event) query = query.where('event', '=', event);
        if (action) query = query.where('action', '=', action);
        if (status) query = query.where('status', '=', status);
        if (deliveryId) query = query.where('delivery_id', 'like', `%${deliveryId}%`);
        if (from) query = query.where('received_at', '>=', new Date(from));
        if (to) query = query.where('received_at', '<', new Date(to));

        let countQuery = deps.db
          .selectFrom('event_log')
          .select(deps.db.fn.countAll<number>().as('total'));
        if (orgId) countQuery = countQuery.where('org_id', '=', orgId);
        if (routingKey) countQuery = countQuery.where('routing_key', '=', routingKey);
        if (event) countQuery = countQuery.where('event', '=', event);
        if (action) countQuery = countQuery.where('action', '=', action);
        if (status) countQuery = countQuery.where('status', '=', status);
        if (deliveryId) countQuery = countQuery.where('delivery_id', 'like', `%${deliveryId}%`);
        if (from) countQuery = countQuery.where('received_at', '>=', new Date(from));
        if (to) countQuery = countQuery.where('received_at', '<', new Date(to));

        const [r, countResult] = await Promise.all([
          query.orderBy('received_at', 'desc').limit(limit).offset(offset).execute(),
          countQuery.executeTakeFirstOrThrow(),
        ]);
        rows = r;
        total = Number(countResult.total);
      }

      return c.json(
        {
          deliveries: rows.map((r) => ({
            orgId: r.org_id,
            deliveryId: r.delivery_id,
            routingKey: r.routing_key,
            event: r.event,
            action: r.action,
            source: r.source,
            provider: r.provider,
            repoIdentifier: r.repo_identifier,
            ref: r.ref,
            status: r.status,
            matchedCount: r.matched_count,
            runId: r.run_id,
            errorMessage: r.error_message,
            receivedAt: r.received_at.toISOString(),
            archivedAt: r.archived_at ? r.archived_at.toISOString() : null,
            payloadOmitted: r.payload_omitted,
            payloadOmittedReason: r.payload_omitted_reason,
            payloadSizeBytes: r.payload_size_bytes,
            payloadHash: r.payload_hash,
          })),
          total,
          limit,
          offset,
        },
        200,
      );
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // ── GET /api/v1/admin/event-log/:deliveryId — full detail ──────
  app.get('/api/v1/admin/event-log/:deliveryId', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'event_log.read');

      const deliveryId = c.req.param('deliveryId');
      const orgId = c.req.query('orgId');
      const routingKeyHint = c.req.query('routingKey') ?? undefined;
      const includePayload = c.req.query('includePayload') === 'true';

      if (!orgId) {
        return c.json({ error: 'Missing required query parameter: orgId' }, 400);
      }

      if (includePayload) {
        // Stricter scope: actual webhook bodies may carry PII.
        deps.rbac.requirePermission(c.get('role'), 'event_log.read_payload');
      }

      // Phase E: hot lookup first; on miss falls back to cold-store
      // (scoped by routingKey when supplied via query).
      const row = await loadEventLogByDeliveryId({
        db: deps.db,
        coldStore: deps.coldStore,
        orgId,
        deliveryId,
        routingKey: routingKeyHint,
      });

      if (!row) {
        return c.json({ error: 'Delivery not found' }, 404);
      }

      const denied = enforceRoutingKeyScope(c, row.routing_key);
      if (denied) return denied;

      const result: Record<string, unknown> = {
        orgId: row.org_id,
        deliveryId: row.delivery_id,
        routingKey: row.routing_key,
        event: row.event,
        action: row.action,
        source: row.source,
        provider: row.provider,
        repoIdentifier: row.repo_identifier,
        ref: row.ref,
        status: row.status,
        matchedCount: row.matched_count,
        runId: row.run_id,
        errorMessage: row.error_message,
        receivedAt: row.received_at.toISOString(),
        archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
        payloadOmitted: row.payload_omitted,
        payloadOmittedReason: row.payload_omitted_reason,
        payloadSizeBytes: row.payload_size_bytes,
        payloadHash: row.payload_hash,
      };

      if (includePayload && !row.payload_omitted && row.payload_key) {
        try {
          const r = await deps.logStorage.read(row.payload_key);
          const buf = Buffer.from(r.data, 'binary');
          const decompressed = gunzipSync(buf);
          result.payload = JSON.parse(decompressed.toString('utf-8'));
        } catch (err) {
          logger.warn('Failed to read or decode event-log payload', {
            deliveryId,
            payloadKey: row.payload_key,
            error: toErrorMessage(err),
          });
          result.payloadReadError = 'Failed to read payload from object storage';
        }
      }

      return c.json(result, 200);
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  return app;
}
