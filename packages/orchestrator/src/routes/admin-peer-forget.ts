/**
 * Forget a departed peer, behind `kici-admin peer forget <instance-id>`.
 *
 * Mounted inside `createAdminRoutes` at `/api/v1/admin`, so the Bearer-token
 * auth middleware has already resolved the caller's role. Needs an unscoped
 * token and the `peer.manage` permission (owner, admin).
 *
 * - `POST /api/v1/admin/peers/forget { instanceId, timeoutMs? }` — drop the
 *   peer from this coordinator's live peer registry, then from every connected
 *   sibling coordinator's, and answer with one result per coordinator.
 *
 * Forgetting never touches the peer's credential (`kici-admin peer revoke`
 * refuses its next connection). A peer that connects again later is
 * registered again as usual.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogSource,
  AccessLogTargetType,
  ActorType,
  PeerForgetOutcome,
} from '@kici-dev/engine';
import type { AccessLogWriter } from '../audit/access-log.js';
import { LOCAL_REFUSALS, type PeerForgetResult } from '../cluster/peer-forget.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import { type AdminEnv, createAdminApp, requireUnscoped } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-peer-forget' });

/** What the route needs from the coordinator it runs on. */
export interface PeerForgetRouteDeps {
  /**
   * Forget `instanceId` here, then on every connected sibling coordinator
   * (skipped when this coordinator keeps the peer). The first result is this
   * coordinator's. `acknowledgeBackstop` lets a forget that switches an
   * event-provision backstop back on go ahead.
   */
  forget: (
    instanceId: string,
    timeoutMs: number,
    acknowledgeBackstop: boolean,
  ) => Promise<PeerForgetResult[]>;
}

/** How long the route waits for each sibling coordinator by default. */
const DEFAULT_TIMEOUT_MS = 15_000;

const bodySchema = z.object({
  instanceId: z.string().trim().min(1).max(256),
  timeoutMs: z.coerce.number().int().min(1_000).max(60_000).default(DEFAULT_TIMEOUT_MS),
  /**
   * Acknowledges that forgetting the peer may switch the event-provision
   * backstop back on. Needed only when it would; absent means not acknowledged.
   */
  acknowledgeBackstop: z.boolean().optional(),
});

export function createPeerForgetRoutes(deps: {
  peerForget: PeerForgetRouteDeps;
  rbac: RbacEnforcer;
  accessLog?: AccessLogWriter;
}): Hono<AdminEnv> {
  const app = createAdminApp(logger);

  app.post('/peers/forget', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'peer.manage');
    const body = bodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: 'Validation error', details: body.error.issues }, 400);
    }
    const { instanceId, timeoutMs } = body.data;
    const acknowledgeBackstop = body.data.acknowledgeBackstop === true;
    const results = await deps.peerForget.forget(instanceId, timeoutMs, acknowledgeBackstop);

    // The first result is this coordinator's: a peer it keeps (connected,
    // heard from inside its liveness window, or guarding its backstop without an
    // acknowledgement) is refused outright, and nothing changed anywhere. A
    // peer no coordinator knows is unknown.
    const local = results[0];
    let error: { status: 404 | 409; message: string } | undefined;
    if (local && LOCAL_REFUSALS.has(local.outcome)) {
      error = { status: 409, message: local.detail };
    } else if (results.every((r) => r.outcome === PeerForgetOutcome.enum['not-found'])) {
      error = { status: 404, message: `peer ${instanceId} is not known to any coordinator` };
    }

    logger.info('Peer forget finished', {
      instanceId,
      actor: c.get('userId'),
      results: results.map((r) => `${r.coordinator}:${r.outcome}`),
    });
    await deps.accessLog?.record({
      orgId: null,
      routingKey: null,
      actor: { type: ActorType.enum.service_account, id: c.get('userId') },
      action: AccessLogAction.enum['peer.forget'],
      target: { type: AccessLogTargetType.enum.fleet, id: instanceId },
      requestId: null,
      source: AccessLogSource.enum.admin_http,
      outcome: error ? AccessLogOutcome.enum.error : AccessLogOutcome.enum.allowed,
      ...(error ? { errorMessage: error.message } : {}),
      meta: { results, acknowledge_backstop: acknowledgeBackstop },
    });
    if (error) {
      const acknowledgementRequired =
        local?.outcome === PeerForgetOutcome.enum['acknowledgement-required'];
      return c.json(
        {
          error: error.message,
          results,
          ...(acknowledgementRequired ? { acknowledgementRequired } : {}),
        },
        error.status,
      );
    }
    return c.json({ instanceId, results });
  });

  return app;
}
