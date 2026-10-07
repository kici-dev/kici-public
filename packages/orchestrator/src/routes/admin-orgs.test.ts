import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import {
  OrgIdSource,
  PlatformAttachment,
  type HeldOrg,
  type OrgListResponse,
} from '../db/repos/org-ids-repo.js';
import { createAdminOrgRoutes } from './admin-orgs.js';

/**
 * `GET /api/v1/admin/org-ids` — the listing behind `kici-admin org list` and the
 * `Org:` line of `kici-admin orchestrator status`.
 *
 * Surface ids exercised here (needled by the coverage gate):
 *   route:GET /org-ids
 */
const S = OrgIdSource.enum;
const ORGS: HeldOrg[] = [
  { orgId: '__default__', sources: [S.source] },
  { orgId: 'org_a', sources: [S['remote-source'], S.context] },
];

function app(opts: {
  role: Role;
  routingKey?: string | null;
  getPlatformOrgId?: () => string | undefined;
}) {
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('role' as never, opts.role as never);
    c.set('userId' as never, 'tester' as never);
    c.set('routingKey' as never, (opts.routingKey ?? null) as never);
    await next();
  });
  root.route(
    '/',
    createAdminOrgRoutes({
      listOrgs: async () => ORGS,
      rbac: new RbacEnforcer(),
      ...(opts.getPlatformOrgId && { getPlatformOrgId: opts.getPlatformOrgId }),
    }),
  );
  return root;
}

async function list(res: Response): Promise<OrgListResponse> {
  expect(res.status).toBe(200);
  return (await res.json()) as OrgListResponse;
}

describe('GET /org-ids', () => {
  it('reports the attached org and merges it into the listing', async () => {
    const body = await list(
      await app({ role: 'admin', getPlatformOrgId: () => 'org_a' }).request('/org-ids'),
    );
    expect(body.platformAttachment).toBe(PlatformAttachment.enum.attached);
    expect(body.attachedOrgId).toBe('org_a');
    expect(body.orgs).toEqual([
      { orgId: '__default__', sources: [S.source] },
      { orgId: 'org_a', sources: [S.platform, S['remote-source'], S.context] },
    ]);
  });

  // fails-when: the attached org is listed only once a table row names it (Review Focus 4)
  it('lists an attached org that no table names yet', async () => {
    const body = await list(
      await app({ role: 'owner', getPlatformOrgId: () => 'org_new' }).request('/org-ids'),
    );
    expect(body.orgs.find((o) => o.orgId === 'org_new')).toEqual({
      orgId: 'org_new',
      sources: [S.platform],
    });
  });

  it('reads pending before the first Platform authentication, none without a Platform client', async () => {
    const pending = await list(
      await app({ role: 'admin', getPlatformOrgId: () => undefined }).request('/org-ids'),
    );
    expect(pending).toMatchObject({
      platformAttachment: PlatformAttachment.enum.pending,
      attachedOrgId: null,
      orgs: ORGS,
    });
    const none = await list(await app({ role: 'admin' }).request('/org-ids'));
    expect(none).toMatchObject({
      platformAttachment: PlatformAttachment.enum.none,
      attachedOrgId: null,
      orgs: ORGS,
    });
  });

  // fails-when: requireUnscopedToken is dropped — a routing-key-scoped token enumerates
  // every org (Review Focus 1)
  it('refuses a routing-key-scoped token', async () => {
    const res = await app({ role: 'owner', routingKey: 'generic:org_a:x' }).request('/org-ids');
    expect(res.status).toBe(403);
  });

  // fails-when: the route checks a permission the auditor holds
  // breaks-if-wrong: owner and admin (above) still read it
  it('refuses the auditor role (secret.read)', async () => {
    const res = await app({ role: 'auditor' }).request('/org-ids');
    expect(res.status).toBe(403);
  });
});
