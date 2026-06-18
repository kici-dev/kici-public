/**
 * Tests for the admin access-log route.
 *
 *   GET /api/v1/admin/access-log         — list with filters (q, action, ...)
 *   GET /api/v1/admin/access-log/:id     — single entry by id
 *
 * Mirrors the Bearer-token + RBAC plumbing shape of admin-event-dlq.test.ts:
 * the AccessLogWriter is stubbed with a vi.fn() so the test can assert the
 * exact filter argument forwarded into `accessLog.query()` — including the
 * `q` substring which the dashboard WS handler already forwards but which
 * the admin HTTP route + CLI omitted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminAccessLogRoutes, type AdminAccessLogRoutesDeps } from './admin-access-log.js';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';

interface Deps extends AdminAccessLogRoutesDeps {
  query: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
}

function createMockDeps(): Deps {
  const query = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
  const getById = vi.fn().mockResolvedValue(null);
  return {
    accessLog: { query, getById } as any,
    tokenManager: { validate: vi.fn() } as any,
    rbac: new RbacEnforcer(),
    query,
    getById,
  };
}

async function request(
  app: ReturnType<typeof createAdminAccessLogRoutes>,
  path: string,
  init?: { token?: string },
) {
  const headers: Record<string, string> = {};
  if (init?.token) headers['Authorization'] = `Bearer ${init.token}`;
  return app.request(`http://localhost${path}`, { method: 'GET', headers });
}

describe('admin access-log routes', () => {
  let deps: Deps;
  let app: ReturnType<typeof createAdminAccessLogRoutes>;
  const TOKEN = 'test-token-abc';

  beforeEach(() => {
    deps = createMockDeps();
    app = createAdminAccessLogRoutes(deps);
    (deps.tokenManager.validate as any).mockResolvedValue({
      id: 'admin-user-1',
      role: 'owner' as Role,
      routingKey: null,
      label: 'test',
    });
  });

  // ── Auth + RBAC ─────────────────────────────────────────────────

  it('rejects requests without a Bearer token', async () => {
    const res = await request(app, '/api/v1/admin/access-log');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid Bearer token', async () => {
    (deps.tokenManager.validate as any).mockResolvedValue(null);
    const res = await request(app, '/api/v1/admin/access-log', { token: TOKEN });
    expect(res.status).toBe(401);
  });

  it('allows auditor role (has access_log.read permission)', async () => {
    (deps.tokenManager.validate as any).mockResolvedValue({
      id: 'auditor',
      role: 'auditor' as Role,
      routingKey: null,
      label: 'test',
    });
    const res = await request(app, '/api/v1/admin/access-log', { token: TOKEN });
    expect(res.status).toBe(200);
  });

  // ── List + filter forwarding ────────────────────────────────────

  it('forwards q to accessLog.query when ?q=<text> is supplied', async () => {
    const res = await request(app, '/api/v1/admin/access-log?q=database%20down', {
      token: TOKEN,
    });
    expect(res.status).toBe(200);
    expect(deps.query).toHaveBeenCalledTimes(1);
    expect(deps.query.mock.calls[0]![0]).toMatchObject({ q: 'database down' });
  });

  it('forwards q: undefined when ?q= is omitted', async () => {
    const res = await request(app, '/api/v1/admin/access-log', { token: TOKEN });
    expect(res.status).toBe(200);
    expect(deps.query).toHaveBeenCalledTimes(1);
    expect(deps.query.mock.calls[0]![0].q).toBeUndefined();
  });

  it('forwards the full filter set when every flag is supplied', async () => {
    const res = await request(
      app,
      '/api/v1/admin/access-log' +
        '?orgId=org-1' +
        '&actorType=user' +
        '&actorId=zsub-42' +
        '&action=run.detail.read' +
        '&source=admin_http' +
        '&outcome=allowed' +
        '&targetType=run' +
        '&targetId=run-1' +
        '&from=2026-05-01T00:00:00Z' +
        '&to=2026-05-09T00:00:00Z' +
        '&q=needle' +
        '&limit=42' +
        '&cursor=abc',
      { token: TOKEN },
    );
    expect(res.status).toBe(200);
    expect(deps.query).toHaveBeenCalledTimes(1);
    expect(deps.query.mock.calls[0]![0]).toMatchObject({
      orgId: 'org-1',
      actorType: 'user',
      actorId: 'zsub-42',
      action: 'run.detail.read',
      source: 'admin_http',
      outcome: 'allowed',
      targetType: 'run',
      targetId: 'run-1',
      fromTimestamp: '2026-05-01T00:00:00Z',
      toTimestamp: '2026-05-09T00:00:00Z',
      q: 'needle',
      limit: 42,
      cursor: 'abc',
    });
  });

  it('clamps limit to 200 max', async () => {
    await request(app, '/api/v1/admin/access-log?limit=99999', { token: TOKEN });
    expect(deps.query.mock.calls[0]![0].limit).toBe(200);
  });

  it('falls back to default 50 when limit parse fails', async () => {
    await request(app, '/api/v1/admin/access-log?limit=notanumber', { token: TOKEN });
    expect(deps.query.mock.calls[0]![0].limit).toBe(50);
  });

  it('returns the items + nextCursor from the writer', async () => {
    deps.query.mockResolvedValue({
      items: [{ id: 'al-1', action: 'run.detail.read' }],
      nextCursor: 'cur-1',
    });
    const res = await request(app, '/api/v1/admin/access-log', { token: TOKEN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('al-1');
    expect(body.nextCursor).toBe('cur-1');
  });

  // ── Show ────────────────────────────────────────────────────────

  it('returns 404 when the entry is not found', async () => {
    deps.getById.mockResolvedValue(null);
    const res = await request(app, '/api/v1/admin/access-log/missing', { token: TOKEN });
    expect(res.status).toBe(404);
  });

  it('returns the entry when found and forwards orgId hint', async () => {
    deps.getById.mockResolvedValue({ id: 'al-1', action: 'run.detail.read' });
    const res = await request(app, '/api/v1/admin/access-log/al-1?orgId=org-1', {
      token: TOKEN,
    });
    expect(res.status).toBe(200);
    expect(deps.getById).toHaveBeenCalledWith('al-1', { orgId: 'org-1' });
    const body = (await res.json()) as any;
    expect(body.id).toBe('al-1');
  });
});
