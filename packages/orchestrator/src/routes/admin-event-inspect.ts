/**
 * Admin API routes for inspecting internal events (`kici_events`).
 *
 *   GET /api/v1/admin/events      — list events, newest first (name, outcome, time filters)
 *   GET /api/v1/admin/events/:id  — one event: its payload and the runs it dispatched
 *
 * Each row carries its dispatch state (`pending`, `leased`, `retrying`,
 * `processed`, `dlq`) and, once processed, how the router resolved it
 * (`matched`, `no-target-repo`, …) with the number of workflows it reached.
 * Both routes need `event_dlq.read`, the permission that already gates reading
 * `kici_events` rows; the payload on `show` also needs
 * `event_log.read_payload`. A routing-key-scoped token sees only events
 * emitted under its own key.
 */
import { Hono } from 'hono';
import type { Kysely } from 'kysely';
import { createLogger } from '@kici-dev/shared';
import type { Database } from '../db/types.js';
import type { EventStore } from '../events/event-store.js';
import {
  EventMatchOutcome,
  eventProcessingState,
  redactEventPayload,
  type StoredEvent,
} from '../events/types.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import { handleAdminError } from './admin-errors.js';
import { enforceRoutingKeyScope } from '../secrets/routing-key-scope.js';
import { createBearerAuthMiddleware } from './admin-auth.js';

const logger = createLogger({ prefix: 'admin-event-inspect' });

export interface AdminEventInspectRoutesDeps {
  db: Kysely<Database>;
  eventStore: EventStore;
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Runs listed on `show`; an event dispatches one run per matched workflow. */
const MAX_RUNS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampLimit(raw: string | undefined): number {
  const parsed = parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/** An ISO timestamp, or `undefined` when absent. `null` means present but unparseable. */
function parseTime(raw: string | undefined): Date | undefined | null {
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toListRow(e: StoredEvent) {
  return {
    id: e.id,
    eventName: e.eventName,
    createdAt: e.createdAt.toISOString(),
    state: eventProcessingState(e),
    matchOutcome: e.matchOutcome,
    matchedCount: e.matchedCount,
    attempts: e.attempts,
    sourceRepo: e.sourceRepo ?? null,
    sourceRoutingKey: e.sourceRoutingKey ?? null,
    targetRepos: e.targetRepos ?? [],
  };
}

export function createAdminEventInspectRoutes(deps: AdminEventInspectRoutesDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // Attached per GET route rather than with `app.use`: `POST
  // /api/v1/admin/events/emit` lives under the same prefix in another router,
  // which runs its own auth.
  const authMiddleware = createBearerAuthMiddleware({
    tokenManager: deps.tokenManager,
    scope: 'admin-event-inspect',
  });

  // ── GET /api/v1/admin/events — list events ─────────────────────
  app.get('/api/v1/admin/events', authMiddleware, async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'event_dlq.read');

      const rawOutcome = c.req.query('outcome');
      let outcome: EventMatchOutcome | undefined;
      if (rawOutcome !== undefined) {
        const parsed = EventMatchOutcome.safeParse(rawOutcome);
        if (!parsed.success) {
          return c.json(
            { error: `outcome must be one of: ${EventMatchOutcome.options.join(', ')}` },
            400,
          );
        }
        outcome = parsed.data;
      }
      const since = parseTime(c.req.query('since'));
      // `before` is either the next-page cursor (the id of the last event on
      // the previous page) or an ISO timestamp.
      const rawBefore = c.req.query('before');
      const afterEventId =
        rawBefore !== undefined && UUID_RE.test(rawBefore) ? rawBefore : undefined;
      const before = afterEventId === undefined ? parseTime(rawBefore) : undefined;
      if (since === null || before === null) {
        return c.json(
          { error: 'since must be an ISO timestamp; before an ISO timestamp or an event id' },
          400,
        );
      }
      const limit = clampLimit(c.req.query('limit'));
      const name = c.req.query('name');
      const tokenRoutingKey = c.get('routingKey') ?? undefined;

      const events = await deps.eventStore.list({
        limit,
        ...(name !== undefined && name !== '' && { name }),
        ...(outcome !== undefined && { outcome }),
        ...(since !== undefined && { since }),
        ...(before !== undefined && { before }),
        ...(afterEventId !== undefined && { afterEventId }),
        ...(tokenRoutingKey !== undefined && { sourceRoutingKey: tokenRoutingKey }),
      });
      const nextCursor = events.length === limit ? events[events.length - 1]!.id : null;

      return c.json({ events: events.map(toListRow), limit, nextCursor }, 200);
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // ── GET /api/v1/admin/events/:id — one event ───────────────────
  app.get('/api/v1/admin/events/:id', authMiddleware, async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'event_dlq.read');

      const id = c.req.param('id');
      if (!UUID_RE.test(id)) {
        return c.json({ error: 'event id must be a UUID' }, 400);
      }
      const event = await deps.eventStore.getById(id);
      if (!event) {
        return c.json({ error: 'Event not found' }, 404);
      }
      const denied = enforceRoutingKeyScope(c, event.sourceRoutingKey ?? null);
      if (denied) return denied;

      // An internal event's dispatched runs carry its id as their delivery id.
      const runs = await deps.db
        .selectFrom('execution_runs')
        .select(['run_id', 'workflow_name', 'status', 'created_at'])
        .where('delivery_id', '=', id)
        .orderBy('created_at', 'asc')
        .limit(MAX_RUNS)
        .execute();

      return c.json(
        {
          ...toListRow(event),
          // Payload bodies are `event_log.read_payload`; `event_dlq.read`
          // alone (the auditor role) reads event metadata only.
          payload: deps.rbac.hasPermission(c.get('role'), 'event_log.read_payload')
            ? redactEventPayload(event.payload)
            : null,
          sourceRunId: event.sourceRunId ?? null,
          sourceJobId: event.sourceJobId ?? null,
          chainDepth: event.chainDepth,
          expiresAt: event.expiresAt.toISOString(),
          lastError: event.lastError,
          nextRetryAt: event.nextRetryAt?.toISOString() ?? null,
          dlqAt: event.dlqAt?.toISOString() ?? null,
          dlqReason: event.dlqReason,
          runs: runs.map((r) => ({
            runId: r.run_id,
            workflowName: r.workflow_name,
            status: r.status,
            createdAt: new Date(r.created_at).toISOString(),
          })),
        },
        200,
      );
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  return app;
}
