/**
 * The `createAdminRoutes` mount seam for the held-run routes.
 * `admin-held-runs.test.ts` drives the factory directly, which proves nothing
 * about whether `admin.ts` mounts it. These go through `createAdminRoutes`
 * with real bearer auth and assert the mount condition: a database, an audit
 * sink, AND the release wiring. Both directions matter: without the wiring the
 * route is ABSENT (404), not mounted with an approve that dispatches nothing;
 * with it, the route answers.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { OrchestratorMode } from '@kici-dev/engine';
import { createAdminRoutes, type AdminRouteDeps } from './admin.js';
import { RbacEnforcer } from '../secrets/rbac.js';
import { PLATFORM_MANAGED_HELD_RUN_MESSAGE } from './admin-held-runs.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import type { Database } from '../db/types.js';
import type { ReleaseSignal } from '../contexts/held-runs.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

const TOKEN = 'admin-token';

function makeDeps(over: Partial<AdminRouteDeps>): AdminRouteDeps {
  return {
    tokenManager: {
      validate: vi.fn().mockResolvedValue({
        id: 'ops-token',
        role: 'owner',
        routingKey: null,
        label: 'test',
      }),
    } as unknown as AdminRouteDeps['tokenManager'],
    rbac: new RbacEnforcer(),
    secretStore: {} as unknown as AdminRouteDeps['secretStore'],
    auditLogger: {} as unknown as AdminRouteDeps['auditLogger'],
    ...over,
  };
}

const release = {
  onJobRelease: vi.fn(async (_s: ReleaseSignal) => {}),
};

const accessLog = { record: vi.fn(async () => {}) } as unknown as AccessLogWriter;

function get(app: ReturnType<typeof createAdminRoutes>, path: string) {
  return app.request(`http://localhost${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

describe('held-run routes mount', () => {
  it('is mounted when db + accessLog + release wiring are all present', async () => {
    const app = createAdminRoutes(
      makeDeps({
        db: createMockDb().db as Kysely<Database>,
        accessLog,
        heldRunRelease: release,
        mode: OrchestratorMode.enum.independent,
      }),
    );
    const res = await get(app, '/api/v1/admin/held-runs?customerId=org-1&runId=run-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ heldRuns: [] });
  });

  it('carries the mode through, so a Platform-attached orchestrator refuses', async () => {
    const app = createAdminRoutes(
      makeDeps({
        db: createMockDb().db as Kysely<Database>,
        accessLog,
        heldRunRelease: release,
        mode: OrchestratorMode.enum.platform,
      }),
    );
    const res = await get(app, '/api/v1/admin/held-runs?customerId=org-1&runId=run-1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(PLATFORM_MANAGED_HELD_RUN_MESSAGE);
  });

  it('defaults an unset mode to the refusing one, never to independent', async () => {
    const app = createAdminRoutes(
      makeDeps({ db: createMockDb().db as Kysely<Database>, accessLog, heldRunRelease: release }),
    );
    const res = await get(app, '/api/v1/admin/held-runs?customerId=org-1&runId=run-1');
    expect(res.status).toBe(409);
  });

  it('is ABSENT without the release wiring — a decision that cannot dispatch is no surface', async () => {
    const app = createAdminRoutes(
      makeDeps({
        db: createMockDb().db as Kysely<Database>,
        accessLog,
        mode: OrchestratorMode.enum.independent,
      }),
    );
    const res = await get(app, '/api/v1/admin/held-runs?customerId=org-1&runId=run-1');
    expect(res.status).toBe(404);
  });

  it('is ABSENT without an audit sink — a locally-answered hold must be attributable', async () => {
    const app = createAdminRoutes(
      makeDeps({
        db: createMockDb().db as Kysely<Database>,
        heldRunRelease: release,
        mode: OrchestratorMode.enum.independent,
      }),
    );
    expect((await get(app, '/api/v1/admin/held-runs?customerId=org-1&runId=run-1')).status).toBe(
      404,
    );
  });

  it('is ABSENT without a database', async () => {
    const app = createAdminRoutes(
      makeDeps({ accessLog, heldRunRelease: release, mode: OrchestratorMode.enum.independent }),
    );
    expect((await get(app, '/api/v1/admin/held-runs?customerId=org-1&runId=run-1')).status).toBe(
      404,
    );
  });

  it('still requires a bearer token', async () => {
    const app = createAdminRoutes(
      makeDeps({
        db: createMockDb().db as Kysely<Database>,
        accessLog,
        heldRunRelease: release,
        mode: OrchestratorMode.enum.independent,
      }),
    );
    const res = await app.request(
      'http://localhost/api/v1/admin/held-runs?customerId=org-1&runId=run-1',
    );
    expect(res.status).toBe(401);
  });
});
