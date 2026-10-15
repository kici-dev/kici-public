import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createAdminContextRoutes } from './admin-contexts.js';
import { RbacEnforcer } from '../secrets/rbac.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

/**
 * The variable CRUD routes read the context row (`executeTakeFirst`) and the
 * variable list (`execute`), upsert through `onConflict(...).execute()` and
 * delete through `deleteFrom(...).where()...execute()`.
 */
function buildMockDb(opts: {
  envRow?: { id: string; org_id: string; name: string } | null;
  listVars?: Array<{ key: string; value: string; locked: boolean; updated_at: string }>;
}) {
  const { db, mocks } = createMockDb({
    selectFirstRow: opts.envRow ?? null,
    selectRows: opts.listVars ?? [],
  });
  return {
    db,
    insertExecute: mocks.onConflictExecute,
    deleteExecute: mocks.deleteExecute,
    insertValues: mocks.insertValues,
    deleteWhere: mocks.deleteWhere,
  };
}

function buildTestApp(deps: { db: any; rbac: RbacEnforcer }) {
  const inner = createAdminContextRoutes(deps);
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

describe('admin context variables CRUD', () => {
  const orgId = 'org-1';
  const env = { id: 'env-abc', org_id: orgId, name: 'production' };

  describe('GET /contexts/:name/variables', () => {
    it('returns variables for an existing context', async () => {
      const { db } = buildMockDb({
        envRow: env,
        listVars: [
          { key: 'DB_URL', value: 'postgres://x', locked: false, updated_at: 't1' },
          { key: 'NODE_ENV', value: 'production', locked: true, updated_at: 't2' },
        ],
      });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      const res = await app.request(
        `http://localhost/contexts/production/variables?orgId=${orgId}`,
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

    it('returns 404 when context is unknown', async () => {
      const { db } = buildMockDb({ envRow: null });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });
      const res = await app.request(`http://localhost/contexts/missing/variables?orgId=${orgId}`, {
        method: 'GET',
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 when orgId is missing', async () => {
      const { db } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });
      const res = await app.request('http://localhost/contexts/production/variables', {
        method: 'GET',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /contexts/:name/variables/:key', () => {
    it('upserts a variable through the variable store', async () => {
      const { db, insertExecute, insertValues } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      const res = await app.request(
        `http://localhost/contexts/production/variables/DB_URL?orgId=${orgId}`,
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
          context_id: env.id,
          key: 'DB_URL',
          value: 'postgres://new',
          locked: true,
        }),
      );
    });

    it('defaults locked to false when omitted', async () => {
      const { db, insertValues } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      await app.request(`http://localhost/contexts/production/variables/PORT?orgId=${orgId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: '8080' }),
      });
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'PORT', value: '8080', locked: false }),
      );
    });

    it('returns 404 when context does not exist', async () => {
      const { db } = buildMockDb({ envRow: null });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      const res = await app.request(
        `http://localhost/contexts/missing/variables/K?orgId=${orgId}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'v' }),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /contexts/:name/variables/:key', () => {
    it('deletes the variable via the variable store', async () => {
      const { db, deleteExecute } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      const res = await app.request(
        `http://localhost/contexts/production/variables/DB_URL?orgId=${orgId}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ deleted: true });
      expect(deleteExecute).toHaveBeenCalled();
    });
  });

  // A variable key is an already-decoded Hono path param. A second decode
  // throws a URIError (500) on a stray `%`, or collapses a `%NN`-looking key
  // onto a DIFFERENT key (wrong-key write or delete). `:key` has no charset
  // validation (only the body is schema-checked), so a key like `100%done` is
  // creatable and both failures are reachable.
  describe('variable :key path param is decoded exactly once (no double-decode)', () => {
    it('PUT forwards a literal-% key verbatim (was a 500 under double-decode)', async () => {
      const { db, insertValues } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      // URL segment `100%25done` decodes (once, by Hono) to the literal `100%done`.
      const res = await app.request(
        `http://localhost/contexts/production/variables/100%25done?orgId=${orgId}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'v' }),
        },
      );

      expect(res.status).toBe(200);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ key: '100%done', value: 'v' }),
      );
    });

    it('DELETE forwards a literal-% key verbatim', async () => {
      const { db, deleteWhere } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      const res = await app.request(
        `http://localhost/contexts/production/variables/100%25done?orgId=${orgId}`,
        { method: 'DELETE' },
      );

      expect(res.status).toBe(200);
      expect(deleteWhere).toHaveBeenCalledWith('key', '=', '100%done');
    });

    it('PUT does not collapse a %NN-looking key onto a different key', async () => {
      const { db, insertValues } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      // URL `a%2520b` → Hono decodes ONCE → `a%20b` (a five-char key). A second
      // decode would wrongly yield `a b` and write a different variable.
      const res = await app.request(
        `http://localhost/contexts/production/variables/a%2520b?orgId=${orgId}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'v' }),
        },
      );

      expect(res.status).toBe(200);
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ key: 'a%20b' }));
      expect(insertValues).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'a b' }));
    });

    it('DELETE does not collapse a %NN-looking key onto a different key', async () => {
      const { db, deleteWhere } = buildMockDb({ envRow: env });
      const app = buildTestApp({ db, rbac: new RbacEnforcer() });

      const res = await app.request(
        `http://localhost/contexts/production/variables/a%2520b?orgId=${orgId}`,
        { method: 'DELETE' },
      );

      expect(res.status).toBe(200);
      expect(deleteWhere).toHaveBeenCalledWith('key', '=', 'a%20b');
      expect(deleteWhere).not.toHaveBeenCalledWith('key', '=', 'a b');
    });
  });
});
