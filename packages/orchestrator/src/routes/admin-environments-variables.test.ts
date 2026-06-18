import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createAdminEnvironmentRoutes } from './admin-environments.js';
import { RbacEnforcer } from '../secrets/rbac.js';

/**
 * Mock Kysely chain that supports the three chains used by the
 * variable CRUD routes:
 *
 *   envStore.getByName(orgId, name)
 *     → selectFrom('environments').selectAll().where().where().executeTakeFirst()
 *   variableStore.listVars(orgId, envId)
 *     → selectFrom('environment_variables').selectAll().where().where().execute()
 *   variableStore.setVar(orgId, envId, key, value, locked)
 *     → insertInto('environment_variables').values(...).onConflict(...).execute()
 *   variableStore.deleteVar(orgId, envId, key)
 *     → deleteFrom('environment_variables').where().where().where().execute()
 */
function buildMockDb(opts: {
  envRow?: { id: string; org_id: string; name: string } | null;
  listVars?: Array<{ key: string; value: string; locked: boolean; updated_at: string }>;
}): {
  db: any;
  insertExecute: ReturnType<typeof vi.fn>;
  deleteExecute: ReturnType<typeof vi.fn>;
  insertValues: ReturnType<typeof vi.fn>;
} {
  const envExecuteTakeFirst = vi.fn().mockResolvedValue(opts.envRow ?? null);
  const envWhere2 = vi.fn();
  const envWhere2Obj: any = { executeTakeFirst: envExecuteTakeFirst };
  envWhere2.mockReturnValue(envWhere2Obj);
  const envWhere1 = vi.fn();
  const envWhere1Obj: any = { where: envWhere2 };
  envWhere1.mockReturnValue(envWhere1Obj);
  const envSelectAll = vi.fn().mockReturnValue({ where: envWhere1 });

  const varListExecute = vi.fn().mockResolvedValue(opts.listVars ?? []);
  const varListWhere2 = vi.fn().mockReturnValue({ execute: varListExecute });
  const varListWhere1 = vi.fn().mockReturnValue({ where: varListWhere2 });
  const varListSelectAll = vi.fn().mockReturnValue({ where: varListWhere1 });

  const insertExecute = vi.fn().mockResolvedValue(undefined);
  const insertOnConflict = vi.fn().mockReturnValue({ execute: insertExecute });
  const insertValues = vi.fn().mockReturnValue({ onConflict: insertOnConflict });

  const deleteExecute = vi.fn().mockResolvedValue(undefined);
  const deleteWhere3 = vi.fn().mockReturnValue({ execute: deleteExecute });
  const deleteWhere2 = vi.fn().mockReturnValue({ where: deleteWhere3 });
  const deleteWhere1 = vi.fn().mockReturnValue({ where: deleteWhere2 });

  const db = {
    selectFrom: vi.fn().mockImplementation((table: string) => {
      if (table === 'environments') return { selectAll: envSelectAll };
      if (table === 'environment_variables') return { selectAll: varListSelectAll };
      return {};
    }),
    insertInto: vi.fn().mockImplementation((table: string) => {
      if (table === 'environment_variables') return { values: insertValues };
      return {};
    }),
    deleteFrom: vi.fn().mockImplementation((table: string) => {
      if (table === 'environment_variables') return { where: deleteWhere1 };
      return {};
    }),
  };

  return { db, insertExecute, deleteExecute, insertValues };
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

describe('admin environment variables CRUD', () => {
  const orgId = 'org-1';
  const env = { id: 'env-abc', org_id: orgId, name: 'production' };

  describe('GET /environments/:name/variables', () => {
    it('returns variables for an existing environment', async () => {
      const { db } = buildMockDb({
        envRow: env,
        listVars: [
          { key: 'DB_URL', value: 'postgres://x', locked: false, updated_at: 't1' },
          { key: 'NODE_ENV', value: 'production', locked: true, updated_at: 't2' },
        ],
      });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      const res = await app.request(
        `http://localhost/environments/production/variables?orgId=${orgId}`,
        { method: 'GET' },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.variables).toHaveLength(2);
      expect(body.variables[0]).toEqual({
        key: 'DB_URL',
        value: 'postgres://x',
        locked: false,
        updated_at: 't1',
      });
    });

    it('returns 404 when environment is unknown', async () => {
      const { db } = buildMockDb({ envRow: null });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });
      const res = await app.request(
        `http://localhost/environments/missing/variables?orgId=${orgId}`,
        { method: 'GET' },
      );
      expect(res.status).toBe(404);
    });

    it('returns 400 when orgId is missing', async () => {
      const { db } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });
      const res = await app.request('http://localhost/environments/production/variables', {
        method: 'GET',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /environments/:name/variables/:key', () => {
    it('upserts a variable through the variable store', async () => {
      const { db, insertExecute, insertValues } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      const res = await app.request(
        `http://localhost/environments/production/variables/DB_URL?orgId=${orgId}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'postgres://new', locked: true }),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ set: true });
      expect(insertExecute).toHaveBeenCalled();
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: orgId,
          environment_id: env.id,
          key: 'DB_URL',
          value: 'postgres://new',
          locked: true,
        }),
      );
    });

    it('defaults locked to false when omitted', async () => {
      const { db, insertValues } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      await app.request(`http://localhost/environments/production/variables/PORT?orgId=${orgId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: '8080' }),
      });
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'PORT', value: '8080', locked: false }),
      );
    });

    it('returns 404 when environment does not exist', async () => {
      const { db } = buildMockDb({ envRow: null });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      const res = await app.request(
        `http://localhost/environments/missing/variables/K?orgId=${orgId}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'v' }),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /environments/:name/variables/:key', () => {
    it('deletes the variable via the variable store', async () => {
      const { db, deleteExecute } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      const res = await app.request(
        `http://localhost/environments/production/variables/DB_URL?orgId=${orgId}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ deleted: true });
      expect(deleteExecute).toHaveBeenCalled();
    });
  });
});
