import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createAdminEnvironmentRoutes } from './admin-environments.js';
import { RbacEnforcer } from '../secrets/rbac.js';

/**
 * Build a hand-rolled chained Kysely-style mock that supports the two
 * shapes used by the GET /environments handler:
 *
 *   1. envStore.list(orgId)  →  selectFrom('environments').selectAll().where().orderBy().execute()
 *   2. The new include-secrets join →
 *      selectFrom('environment_bindings as eb').innerJoin('scoped_secrets as ss', ...)
 *        .select(...).where().where().where().distinct().execute()
 *
 * The two shapes diverge at the first call after selectFrom (`selectAll` vs `innerJoin`).
 */
function buildMockDb(opts: {
  envRows: unknown[];
  bindingRows: Array<{ environment_id: string; key: string }>;
}): { db: any } {
  // Shape 1: envStore.list ─────────────────────────────────────────
  const listExecute = vi.fn().mockResolvedValue(opts.envRows);
  const listChain: Record<string, any> = {
    where: vi.fn(),
    orderBy: vi.fn(),
    execute: listExecute,
  };
  listChain.where.mockReturnValue(listChain);
  listChain.orderBy.mockReturnValue(listChain);
  const listSelectAll = vi.fn().mockReturnValue(listChain);

  // Shape 2: include-secrets join ──────────────────────────────────
  const joinExecute = vi.fn().mockResolvedValue(opts.bindingRows);
  const joinChain: Record<string, any> = {
    where: vi.fn(),
    distinct: vi.fn(),
    execute: joinExecute,
  };
  joinChain.where.mockReturnValue(joinChain);
  joinChain.distinct.mockReturnValue(joinChain);

  const joinSelect = vi.fn().mockReturnValue(joinChain);
  const innerJoin = vi.fn().mockReturnValue({ select: joinSelect });

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === 'environment_bindings as eb') {
        return { innerJoin };
      }
      return { selectAll: listSelectAll };
    }),
  };
  return { db };
}

/**
 * Build a parent Hono app that injects the `role` + `userId` context vars
 * (normally set by the admin auth middleware in admin.ts) and mounts the
 * environment routes underneath. This lets us hit the routes directly
 * without standing up the full auth stack.
 */
function buildTestApp(deps: { db: any; rbac: RbacEnforcer }) {
  const inner = createAdminEnvironmentRoutes(deps);
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('role' as never, 'admin' as never);
    c.set('userId' as never, 'tester' as never);
    await next();
  });
  root.route('/', inner);
  return root;
}

async function getEnvironments(
  app: ReturnType<typeof buildTestApp>,
  query: string,
): Promise<{ status: number; body: any }> {
  const res = await app.request(`http://localhost/environments?${query}`, { method: 'GET' });
  const body = await res.json();
  return { status: res.status, body };
}

describe('GET /api/v1/admin/environments — includeSecrets handling', () => {
  const orgId = 'org-1';
  const envRow1 = {
    id: 'env-1',
    org_id: orgId,
    name: 'test-pg',
    type: 'fixed',
    enabled: true,
    allow_local_execution: true,
  };
  const envRow2 = {
    id: 'env-2',
    org_id: orgId,
    name: 'production',
    type: 'fixed',
    enabled: true,
    allow_local_execution: false,
  };

  it('returns env rows unchanged when includeSecrets is absent (back-compat)', async () => {
    const { db } = buildMockDb({ envRows: [envRow1, envRow2], bindingRows: [] });
    const app = buildTestApp({ db, rbac: new RbacEnforcer() });

    const { status, body } = await getEnvironments(app, `orgId=${orgId}`);

    expect(status).toBe(200);
    expect(body.environments).toHaveLength(2);
    expect(body.environments[0].secret_keys).toBeUndefined();
    expect(body.environments[1].secret_keys).toBeUndefined();
    expect((db.selectFrom as any).mock.calls).toEqual([['environments']]);
  });

  it('appends secret_keys per env when includeSecrets=true, distinct + sorted', async () => {
    const { db } = buildMockDb({
      envRows: [envRow1, envRow2],
      bindingRows: [
        { environment_id: 'env-1', key: 'PGUSER' },
        { environment_id: 'env-1', key: 'PGPASSWORD' },
        { environment_id: 'env-2', key: 'DB_HOST' },
        { environment_id: 'env-1', key: 'PGUSER' }, // dedup test
      ],
    });
    const app = buildTestApp({ db, rbac: new RbacEnforcer() });

    const { status, body } = await getEnvironments(app, `orgId=${orgId}&includeSecrets=true`);

    expect(status).toBe(200);
    expect(body.environments).toHaveLength(2);
    expect(body.environments[0].name).toBe('test-pg');
    expect(body.environments[0].secret_keys).toEqual(['PGPASSWORD', 'PGUSER']);
    expect(body.environments[1].name).toBe('production');
    expect(body.environments[1].secret_keys).toEqual(['DB_HOST']);
  });

  it('returns empty secret_keys array for envs with no bindings', async () => {
    const { db } = buildMockDb({
      envRows: [envRow1, envRow2],
      bindingRows: [{ environment_id: 'env-1', key: 'ONLY' }],
    });
    const app = buildTestApp({ db, rbac: new RbacEnforcer() });

    const { body } = await getEnvironments(app, `orgId=${orgId}&includeSecrets=true`);

    expect(body.environments[1].secret_keys).toEqual([]);
  });

  it('skips the join query when env list is empty', async () => {
    const { db } = buildMockDb({ envRows: [], bindingRows: [] });
    const app = buildTestApp({ db, rbac: new RbacEnforcer() });

    const { body } = await getEnvironments(app, `orgId=${orgId}&includeSecrets=true`);

    expect(body.environments).toEqual([]);
    expect((db.selectFrom as any).mock.calls).toEqual([['environments']]);
  });

  it('rejects requests without orgId', async () => {
    const { db } = buildMockDb({ envRows: [], bindingRows: [] });
    const app = buildTestApp({ db, rbac: new RbacEnforcer() });

    const { status, body } = await getEnvironments(app, 'includeSecrets=true');

    expect(status).toBe(400);
    expect(body.error).toContain('orgId');
  });
});
