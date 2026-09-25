import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createAdminContextRoutes } from './admin-contexts.js';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

/**
 * The per-source override routes: the `kici-admin context source-override`
 * operator path for the dashboard's `contexts.source_overrides.*` writes.
 * The context is addressed by name with `?orgId=`; the store calls carry its id.
 */

const ORG = 'org-1';
const ENV = { id: 'env-abc', org_id: ORG, name: 'production' };

function overrideRow(routingKey: string, key: string, value: string, contextId = ENV.id) {
  return {
    id: `${routingKey}/${key}`,
    org_id: ORG,
    context_id: contextId,
    routing_key: routingKey,
    key,
    value,
    created_at: 't0',
    updated_at: 't1',
  };
}

function buildTestApp(db: unknown, opts: { role?: Role; routingKey?: string | null } = {}) {
  const inner = createAdminContextRoutes({ db: db as never, rbac: new RbacEnforcer() });
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('role' as never, (opts.role ?? 'admin') as never);
    c.set('userId' as never, 'tester' as never);
    c.set('routingKey' as never, (opts.routingKey ?? null) as never);
    await next();
  });
  root.route('/', inner);
  return root;
}

describe('admin context source-override routes', () => {
  describe('GET /contexts/:name/source-overrides', () => {
    it('lists every source override in the context when no routing key is given', async () => {
      const { db } = createMockDb({
        selectFirstRow: ENV,
        selectRows: [
          overrideRow('generic:ops', 'REGION', 'eu'),
          overrideRow('github:42', 'API_URL', 'https://a'),
          overrideRow('github:42', 'API_URL', 'https://other', 'env-other'),
        ],
      });
      const app = buildTestApp(db);

      const res = await app.request(
        `http://localhost/contexts/production/source-overrides?orgId=${ORG}`,
      );

      expect(res.status).toBe(200);
      // fails-when: the list is not narrowed to the context's id — the
      //   env-other row would appear.
      expect((await res.json()).overrides).toEqual([
        { routing_key: 'generic:ops', key: 'REGION', value: 'eu', updated_at: 't1' },
        { routing_key: 'github:42', key: 'API_URL', value: 'https://a', updated_at: 't1' },
      ]);
    });

    it('narrows the list to one source with ?routingKey=', async () => {
      const { db, mocks } = createMockDb({
        selectFirstRow: ENV,
        selectRows: [
          overrideRow('generic:ops', 'REGION', 'eu'),
          overrideRow('github:42', 'API_URL', 'https://a'),
        ],
      });
      const app = buildTestApp(db);

      const res = await app.request(
        `http://localhost/contexts/production/source-overrides?orgId=${ORG}&routingKey=${encodeURIComponent('github:42')}`,
      );

      expect(res.status).toBe(200);
      expect(mocks.selectWhere).toHaveBeenCalledWith('routing_key', '=', 'github:42');
      expect((await res.json()).overrides).toEqual([
        { routing_key: 'github:42', key: 'API_URL', value: 'https://a', updated_at: 't1' },
      ]);
    });

    it('returns 404 when the context does not exist in the org', async () => {
      const { db } = createMockDb({ selectFirstRow: ENV });
      const app = buildTestApp(db);
      const res = await app.request(
        'http://localhost/contexts/production/source-overrides?orgId=other',
      );
      expect(res.status).toBe(404);
    });

    it('returns 400 when orgId is missing', async () => {
      const { db } = createMockDb({ selectFirstRow: ENV });
      const app = buildTestApp(db);
      const res = await app.request('http://localhost/contexts/production/source-overrides');
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /contexts/:name/source-overrides/:routingKey/:key', () => {
    it('upserts the override under the context id, with the routing key decoded once', async () => {
      const { db, mocks } = createMockDb({ selectFirstRow: ENV });
      const app = buildTestApp(db);

      const res = await app.request(
        `http://localhost/contexts/production/source-overrides/${encodeURIComponent('github:42')}/API_URL?orgId=${ORG}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'https://override' }),
        },
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ set: true });
      expect(mocks.insertInto).toHaveBeenCalledWith('context_source_overrides');
      expect(mocks.insertValues).toHaveBeenCalledWith({
        org_id: ORG,
        context_id: ENV.id,
        routing_key: 'github:42',
        key: 'API_URL',
        value: 'https://override',
      });
    });

    it('returns 400 and writes nothing when the body has no value', async () => {
      const { db, mocks } = createMockDb({ selectFirstRow: ENV });
      const app = buildTestApp(db);
      const res = await app.request(
        `http://localhost/contexts/production/source-overrides/github%3A42/API_URL?orgId=${ORG}`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      expect(res.status).toBe(400);
      expect(mocks.insertValues).not.toHaveBeenCalled();
    });

    it('returns 404 and writes nothing when the context does not exist', async () => {
      const { db, mocks } = createMockDb({ selectFirstRow: undefined });
      const app = buildTestApp(db);
      const res = await app.request(
        `http://localhost/contexts/missing/source-overrides/github%3A42/API_URL?orgId=${ORG}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'v' }),
        },
      );
      expect(res.status).toBe(404);
      expect(mocks.insertValues).not.toHaveBeenCalled();
    });

    it('refuses a role without secret.write and writes nothing', async () => {
      // fails-when: the route skips its RBAC check, so an auditor could write.
      // breaks-if-wrong: the admin role in the tests above must still write.
      const { db, mocks } = createMockDb({ selectFirstRow: ENV });
      const app = buildTestApp(db, { role: 'auditor' });
      const res = await app.request(
        `http://localhost/contexts/production/source-overrides/github%3A42/API_URL?orgId=${ORG}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'v' }),
        },
      );
      expect(res.status).toBe(403);
      expect(mocks.insertValues).not.toHaveBeenCalled();
    });

    it('refuses a routing-key-scoped token and writes nothing', async () => {
      // Contexts are org-scoped, so the router-level guard refuses any token
      // restricted to one routing key — even the override's own.
      const { db, mocks } = createMockDb({ selectFirstRow: ENV });
      const app = buildTestApp(db, { routingKey: 'github:42' });
      const res = await app.request(
        `http://localhost/contexts/production/source-overrides/github%3A42/API_URL?orgId=${ORG}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'v' }),
        },
      );
      expect(res.status).toBe(403);
      expect(mocks.insertValues).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /contexts/:name/source-overrides/:routingKey/:key', () => {
    it('deletes the override addressed by context id, routing key and key', async () => {
      const { db, mocks } = createMockDb({ selectFirstRow: ENV });
      const app = buildTestApp(db);

      const res = await app.request(
        `http://localhost/contexts/production/source-overrides/github%3A42/API_URL?orgId=${ORG}`,
        { method: 'DELETE' },
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });
      expect(mocks.deleteFrom).toHaveBeenCalledWith('context_source_overrides');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('context_id', '=', ENV.id);
      expect(mocks.deleteWhere).toHaveBeenCalledWith('routing_key', '=', 'github:42');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('key', '=', 'API_URL');
    });

    it('refuses a role without secret.delete and deletes nothing', async () => {
      const { db, mocks } = createMockDb({ selectFirstRow: ENV });
      const app = buildTestApp(db, { role: 'auditor' });
      const res = await app.request(
        `http://localhost/contexts/production/source-overrides/github%3A42/API_URL?orgId=${ORG}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(403);
      expect(mocks.deleteFrom).not.toHaveBeenCalled();
    });
  });
});
