/**
 * Admin API route listing the org ids this orchestrator holds data for.
 *
 *   GET /api/v1/admin/org-ids → `OrgListResponse`: every org id the configuration
 *   and anchor tables name, each with the data that names it, plus the live
 *   Platform attachment (`attached` / `pending` / `none`).
 *
 * Backs `kici-admin org list` and the `Org:` line of `kici-admin orchestrator
 * status`. The listing spans every org, so the route requires an unscoped token
 * and `secret.read`, like the other read-only inspection routes.
 */
import { Hono } from 'hono';
import { createLogger } from '@kici-dev/shared';
import {
  readPlatformAttachment,
  withPlatformOrg,
  type HeldOrg,
  type OrgListResponse,
} from '../db/repos/org-ids-repo.js';
import type { RbacEnforcer } from '../secrets/rbac.js';
import { type AdminEnv, createAdminApp, requireUnscoped } from './admin-env.js';

const logger = createLogger({ prefix: 'admin-orgs' });

export interface AdminOrgRoutesDeps {
  /** The org ids the database holds (`listHeldOrgIds` bound to the orchestrator DB). */
  listOrgs: () => Promise<HeldOrg[]>;
  rbac: RbacEnforcer;
  /**
   * The org the Platform named on `auth.success`; `undefined` before the first
   * authentication. Absent when no Platform client runs (independent mode).
   */
  getPlatformOrgId?: () => string | undefined;
}

export function createAdminOrgRoutes(deps: AdminOrgRoutesDeps): Hono<AdminEnv> {
  const app = createAdminApp(logger);

  // fails-when: a routing-key-scoped token lists every org.
  // breaks-if-wrong: an unscoped owner or admin token must still read it.
  app.get('/org-ids', requireUnscoped, async (c) => {
    deps.rbac.requirePermission(c.get('role'), 'secret.read');
    const attachment = readPlatformAttachment(deps.getPlatformOrgId);
    const body: OrgListResponse = {
      ...attachment,
      orgs: withPlatformOrg(await deps.listOrgs(), attachment.attachedOrgId),
    };
    return c.json(body);
  });

  return app;
}
