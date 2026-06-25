import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createAdminEnvironmentRoutes } from './admin-environments.js';
import { RbacEnforcer } from '../secrets/rbac.js';

/**
 * Mock Kysely chain for the bind route, covering:
 *   envStore.getByName → selectFrom('environments').selectAll().where().where().executeTakeFirst()
 *   existence check    → selectFrom('environment_bindings').select().where×4.executeTakeFirst()
 *   insert             → insertInto('environment_bindings').values(...).execute()
 */
function buildMockDb(opts: {
  envRow?: { id: string; org_id: string; name: string } | null;
  existingBinding?: { scope_pattern: string } | null;
}): { db: any; insertValues: ReturnType<typeof vi.fn> } {
  const envExecuteTakeFirst = vi.fn().mockResolvedValue(opts.envRow ?? null);
  const envWhere2 = vi.fn().mockReturnValue({ executeTakeFirst: envExecuteTakeFirst });
  const envWhere1 = vi.fn().mockReturnValue({ where: envWhere2 });
  const envSelectAll = vi.fn().mockReturnValue({ where: envWhere1 });

  // 4-where chain on the existence check (org, env, scope, host).
  const existExecuteTakeFirst = vi.fn().mockResolvedValue(opts.existingBinding ?? null);
  const chainWhere = (depth: number): any =>
    depth === 0
      ? { executeTakeFirst: existExecuteTakeFirst }
      : { where: () => chainWhere(depth - 1) };
  const bindingSelect = vi.fn().mockReturnValue({ where: () => chainWhere(3) });

  const insertExecute = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn().mockReturnValue({ execute: insertExecute });

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === 'environments') return { selectAll: envSelectAll };
      if (table === 'environment_bindings') return { select: bindingSelect };
      return {};
    }),
    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === 'environment_bindings') return { values: insertValues };
      return {};
    }),
  };

  return { db, insertValues };
}

function buildTestApp(deps: { db: any; rbac: RbacEnforcer }) {
  const inner = createAdminEnvironmentRoutes(deps);
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('role' as never, 'admin' as never);
    c.set('userId' as never, 'tester' as never);
    c.set('routingKey' as never, null as never);
    await next();
  });
  root.route('/', inner);
  return root;
}

describe('POST /environments/:name/bind — host_pattern', () => {
  const orgId = 'org-1';
  const env = { id: 'env-abc', org_id: orgId, name: 'production' };

  it('persists an explicit host_pattern', async () => {
    const { db, insertValues } = buildMockDb({ envRow: env, existingBinding: null });
    const app = buildTestApp({ db, rbac: new RbacEnforcer() });

    const res = await app.request('http://localhost/environments/production/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId,
        scopePattern: 'prod/hosts/box-00002/**',
        hostPattern: 'box-00002',
      }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ created: true });
    expect(insertValues).toHaveBeenCalledWith({
      org_id: orgId,
      environment_id: 'env-abc',
      scope_pattern: 'prod/hosts/box-00002/**',
      host_pattern: 'box-00002',
    });
  });

  it('defaults host_pattern to ** when omitted', async () => {
    const { db, insertValues } = buildMockDb({ envRow: env, existingBinding: null });
    const app = buildTestApp({ db, rbac: new RbacEnforcer() });

    const res = await app.request('http://localhost/environments/production/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId, scopePattern: 'prod/shared/**' }),
    });

    expect(res.status).toBe(201);
    expect(insertValues).toHaveBeenCalledWith({
      org_id: orgId,
      environment_id: 'env-abc',
      scope_pattern: 'prod/shared/**',
      host_pattern: '**',
    });
  });
});
