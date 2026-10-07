/**
 * Reload the scaler config, behind `kici-admin scaler reload`.
 *
 * Mounted inside `createAdminRoutes` at `/api/v1/admin`, so the Bearer-token
 * auth middleware has already resolved the caller's role. Needs an unscoped
 * token and the `scaler.manage` permission (owner, admin).
 *
 * - `POST /api/v1/admin/scaler/reload { single?, timeoutMs? }` — re-read the
 *   scaler config on this orchestrator and, unless `single`, on every peer it
 *   is connected to. Each orchestrator applies its own file completely or not
 *   at all. Answers `{ scope, results }` with one result per instance, this
 *   one first: `200` when no instance refused its file or went unanswered,
 *   `422` otherwise.
 *
 * The route runs the scaler reload only: it does not reload the orchestrator
 * config, so it never bumps the config version the peers follow, and a
 * `single` reload stays on this orchestrator.
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
  ScalerReloadOutcome,
  type ScalerReloadInstanceResult,
} from '@kici-dev/engine';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import { type AdminEnv, createAdminApp, requireUnscoped } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-scaler-reload' });

/** What the route needs from the orchestrator it runs on. */
export interface ScalerReloadRouteDeps {
  /** This orchestrator's instance id, the audit row's target. */
  instanceId: string;
  /**
   * Reload here and, unless `single`, on every connected peer, waiting
   * `timeoutMs` for each peer. The first result is this orchestrator's.
   */
  reload: (single: boolean, timeoutMs: number) => Promise<ScalerReloadInstanceResult[]>;
}

/** How long the route waits for each peer by default. */
export const DEFAULT_SCALER_RELOAD_TIMEOUT_MS = 60_000;

/** Outcomes that make the request fail: a refused file, or an instance not reached. */
const FAILED_OUTCOMES: ReadonlySet<ScalerReloadOutcome> = new Set([
  ScalerReloadOutcome.enum.rejected,
  ScalerReloadOutcome.enum.unreachable,
]);

const bodySchema = z.object({
  single: z.boolean().optional(),
  timeoutMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(240_000)
    .default(DEFAULT_SCALER_RELOAD_TIMEOUT_MS),
});

export function createScalerReloadRoutes(deps: {
  scalerReload: ScalerReloadRouteDeps;
  rbac: RbacEnforcer;
  accessLog?: AccessLogWriter;
}): Hono<AdminEnv> {
  const app = createAdminApp(logger);

  app.post('/scaler/reload', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'scaler.manage');
    const body = bodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json({ error: 'Validation error', details: body.error.issues }, 400);
    }
    const single = body.data.single === true;
    const results = await deps.scalerReload.reload(single, body.data.timeoutMs);
    const failed = results.filter((r) => FAILED_OUTCOMES.has(r.outcome));

    logger.info('Scaler reload finished', {
      single,
      actor: c.get('userId'),
      outcomes: results.map((r) => `${r.instanceId}:${r.outcome}`),
    });
    await deps.accessLog?.record({
      orgId: null,
      routingKey: null,
      actor: { type: ActorType.enum.service_account, id: c.get('userId') },
      action: AccessLogAction.enum['scaler.reload'],
      target: { type: AccessLogTargetType.enum.scaler, id: deps.scalerReload.instanceId },
      requestId: null,
      source: AccessLogSource.enum.admin_http,
      outcome: failed.length > 0 ? AccessLogOutcome.enum.error : AccessLogOutcome.enum.allowed,
      ...(failed.length > 0
        ? {
            errorMessage: `scaler reload ${failed
              .map((r) => `${r.outcome} on ${r.instanceId}`)
              .join(', ')}`,
          }
        : {}),
      meta: { single, results },
    });
    return c.json({ scope: single ? 'single' : 'cluster', results }, failed.length > 0 ? 422 : 200);
  });

  return app;
}
