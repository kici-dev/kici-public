/**
 * Orchestrator drain admin routes.
 *
 * Backs the `kici-admin orchestrator drain` / `resume` / `drain --status`
 * verbs used to quiesce a coordinator before an upgrade. Mounted inside
 * `createAdminRoutes` at `/api/v1/admin/orchestrator/drain`, so it inherits the
 * Bearer-token auth middleware (which resolves the caller's role) and gates on
 * the `orchestrator.drain` RBAC permission (owner + admin).
 *
 * - `GET  /api/v1/admin/orchestrator/drain` → current `{ draining, jobsRunning }`.
 * - `POST /api/v1/admin/orchestrator/drain { action: 'drain' | 'resume' }` →
 *   flips the drain flag and returns the new snapshot.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { createLogger } from '@kici-dev/shared';
import type { DrainController } from '../drain/drain-controller.js';
import type { RbacEnforcer, Role } from '../secrets/rbac.js';
import { handleAdminError } from './admin-errors.js';

const logger = createLogger({ prefix: 'admin-orchestrator-drain' });

export const DrainActionSchema = z.enum(['drain', 'resume']);
export type DrainAction = z.infer<typeof DrainActionSchema>;

type AdminEnv = {
  Variables: {
    role: Role;
    userId: string;
    routingKey: string | null;
  };
};

export function createOrchestratorDrainRoutes(deps: {
  drainController: DrainController;
  rbac: RbacEnforcer;
}): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // GET — report drain status, no state change.
  app.get('/orchestrator/drain', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'orchestrator.drain');
      return c.json(await deps.drainController.snapshot(), 200);
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  // POST — flip the drain flag on ('drain') or off ('resume').
  app.post('/orchestrator/drain', async (c) => {
    try {
      deps.rbac.requirePermission(c.get('role'), 'orchestrator.drain');
      const body = await c.req.json().catch(() => ({}));
      const parsed = DrainActionSchema.safeParse((body as { action?: unknown }).action);
      if (!parsed.success) {
        return c.json({ error: "action must be 'drain' or 'resume'" }, 400);
      }
      if (parsed.data === DrainActionSchema.enum.drain) {
        deps.drainController.startDrain();
      } else {
        deps.drainController.stopDrain();
      }
      return c.json(await deps.drainController.snapshot(), 200);
    } catch (err) {
      return handleAdminError(c, err, logger);
    }
  });

  return app;
}
