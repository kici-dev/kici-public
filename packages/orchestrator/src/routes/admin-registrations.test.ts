import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAdminRegistrationRoutes,
  type AdminRegistrationRoutesDeps,
} from './admin-registrations.js';
import type { Role } from '../secrets/rbac.js';
import { RbacEnforcer } from '../secrets/rbac.js';

/**
 * Create mock admin registration route dependencies.
 */
function createMockDeps(
  overrides?: Partial<AdminRegistrationRoutesDeps>,
): AdminRegistrationRoutesDeps {
  return {
    registrationStore: {
      getAll: vi.fn().mockResolvedValue([]),
      getByRoutingKey: vi.fn().mockResolvedValue([]),
      getByRoutingKeyAndRepo: vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue(null),
      deleteById: vi.fn().mockResolvedValue(false),
      bumpVersion: vi.fn().mockResolvedValue(1),
      getVersion: vi.fn().mockResolvedValue(0),
    } as any,
    registrationIndex: {
      loadFromDb: vi.fn().mockResolvedValue(undefined),
      refreshIfNeeded: vi.fn().mockResolvedValue(undefined),
      getVersion: vi.fn().mockReturnValue(0),
    } as any,
    tokenManager: {
      validate: vi.fn(),
    } as any,
    rbac: new RbacEnforcer(),
    ...overrides,
  };
}

/** Helper: make a request to the admin registration routes app. */
async function request(
  app: ReturnType<typeof createAdminRegistrationRoutes>,
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string },
) {
  const headers: Record<string, string> = {};
  if (opts?.token) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }
  if (opts?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const init: RequestInit = {
    method,
    headers,
  };
  if (opts?.body !== undefined) {
    init.body = JSON.stringify(opts.body);
  }

  const url = `http://localhost/api/v1/admin${path}`;
  return app.request(url, init);
}

const sampleRegistration = {
  id: 'reg-1',
  customer_id: 'cust-1',
  repo_identifier: 'owner/repo',
  workflow_name: 'ci',
  lock_entry: {
    name: 'ci',
    triggers: [{ _type: 'push' }],
    jobs: [],
  },
  trigger_types: ['push'],
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

describe('admin registration routes', () => {
  let deps: AdminRegistrationRoutesDeps;
  let app: ReturnType<typeof createAdminRegistrationRoutes>;
  const validToken = 'test-token-abc123';

  beforeEach(() => {
    deps = createMockDeps();
    app = createAdminRegistrationRoutes(deps);

    // Default: validate returns owner role
    (deps.tokenManager.validate as any).mockResolvedValue({
      id: 'user-1',
      role: 'owner' as Role,
      label: 'test',
    });
  });

  // ---- Auth middleware ----

  describe('auth middleware', () => {
    it('rejects missing Authorization header with 401', async () => {
      const res = await request(app, 'GET', '/registrations');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Missing authorization');
    });

    it('rejects invalid token with 401', async () => {
      (deps.tokenManager.validate as any).mockResolvedValue(null);
      const res = await request(app, 'GET', '/registrations', { token: 'invalid' });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid or expired token');
    });
  });

  // ---- GET /registrations ----

  describe('GET /registrations', () => {
    it('returns empty list when no registrations exist', async () => {
      const res = await request(app, 'GET', '/registrations', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registrations).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns all registrations', async () => {
      (deps.registrationStore.getAll as any).mockResolvedValue([sampleRegistration]);
      const res = await request(app, 'GET', '/registrations', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registrations).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(body.registrations[0].workflow_name).toBe('ci');
    });

    it('filters by routingKey', async () => {
      (deps.registrationStore.getByRoutingKey as any).mockResolvedValue([sampleRegistration]);
      const res = await request(app, 'GET', '/registrations?routingKey=github:42', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      expect(deps.registrationStore.getByRoutingKey).toHaveBeenCalledWith('github:42');
    });

    it('filters by routingKey and repoIdentifier', async () => {
      (deps.registrationStore.getByRoutingKeyAndRepo as any).mockResolvedValue([
        sampleRegistration,
      ]);
      const res = await request(
        app,
        'GET',
        '/registrations?routingKey=github:42&repoIdentifier=owner/repo',
        { token: validToken },
      );
      expect(res.status).toBe(200);
      expect(deps.registrationStore.getByRoutingKeyAndRepo).toHaveBeenCalledWith(
        'github:42',
        'owner/repo',
      );
    });

    it('filters by triggerType', async () => {
      const reg2 = {
        ...sampleRegistration,
        id: 'reg-2',
        workflow_name: 'cron-job',
        trigger_types: ['schedule'],
      };
      (deps.registrationStore.getAll as any).mockResolvedValue([sampleRegistration, reg2]);
      const res = await request(app, 'GET', '/registrations?triggerType=schedule', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registrations).toHaveLength(1);
      expect(body.registrations[0].workflow_name).toBe('cron-job');
    });

    // ---- customerId, event, repoIdentifier filters ----

    const orgARegWebhookFoo = {
      ...sampleRegistration,
      id: 'reg-orgA-foo',
      customerId: 'orgA',
      workflow_name: 'orgA-foo',
      trigger_types: ['webhook'],
      lock_entry: {
        name: 'orgA-foo',
        triggers: [{ _type: 'webhook', events: ['foo'] }],
        jobs: [],
      },
    };
    const orgARegWebhookBar = {
      ...sampleRegistration,
      id: 'reg-orgA-bar',
      customerId: 'orgA',
      workflow_name: 'orgA-bar',
      trigger_types: ['webhook'],
      lock_entry: {
        name: 'orgA-bar',
        triggers: [{ _type: 'webhook', events: ['bar'] }],
        jobs: [],
      },
    };
    const orgBRegWebhookFoo = {
      ...sampleRegistration,
      id: 'reg-orgB-foo',
      customerId: 'orgB',
      workflow_name: 'orgB-foo',
      trigger_types: ['webhook'],
      lock_entry: {
        name: 'orgB-foo',
        triggers: [{ _type: 'webhook', events: ['foo'] }],
        jobs: [],
      },
    };
    const orgARegKiciEvent = {
      ...sampleRegistration,
      id: 'reg-orgA-kici',
      customerId: 'orgA',
      workflow_name: 'orgA-kici',
      trigger_types: ['kici_event'],
      lock_entry: {
        name: 'orgA-kici',
        triggers: [{ _type: 'kici_event', events: ['foo'] }],
        jobs: [],
      },
    };

    it('R-2: filters by customerId (and org alias)', async () => {
      (deps.registrationStore.getAll as any).mockResolvedValue([
        orgARegWebhookFoo,
        orgBRegWebhookFoo,
      ]);
      let res = await request(app, 'GET', '/registrations?customerId=orgA', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      let body = await res.json();
      expect(body.registrations).toHaveLength(1);
      expect(body.registrations[0].id).toBe('reg-orgA-foo');

      // org alias
      (deps.registrationStore.getAll as any).mockResolvedValue([
        orgARegWebhookFoo,
        orgBRegWebhookFoo,
      ]);
      res = await request(app, 'GET', '/registrations?org=orgA', { token: validToken });
      expect(res.status).toBe(200);
      body = await res.json();
      expect(body.registrations).toHaveLength(1);
      expect(body.registrations[0].id).toBe('reg-orgA-foo');
    });

    it('R-3: filters by event=foo (only webhook triggers, kici_event excluded)', async () => {
      (deps.registrationStore.getAll as any).mockResolvedValue([
        orgARegWebhookFoo,
        orgARegWebhookBar,
        orgARegKiciEvent,
      ]);
      const res = await request(app, 'GET', '/registrations?event=foo', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registrations).toHaveLength(1);
      expect(body.registrations[0].id).toBe('reg-orgA-foo');
    });

    it('R-4: filters by customerId AND event (AND-combined)', async () => {
      (deps.registrationStore.getAll as any).mockResolvedValue([
        orgARegWebhookFoo,
        orgARegWebhookBar,
        orgBRegWebhookFoo,
      ]);
      const res = await request(app, 'GET', '/registrations?customerId=orgA&event=foo', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registrations).toHaveLength(1);
      expect(body.registrations[0].id).toBe('reg-orgA-foo');
    });

    it('R-5: filters by triggerType=webhook', async () => {
      (deps.registrationStore.getAll as any).mockResolvedValue([
        orgARegWebhookFoo,
        orgARegKiciEvent,
      ]);
      const res = await request(app, 'GET', '/registrations?triggerType=webhook', {
        token: validToken,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registrations).toHaveLength(1);
      expect(body.registrations[0].id).toBe('reg-orgA-foo');
    });

    it('R-6: response shape is { registrations, total }', async () => {
      (deps.registrationStore.getAll as any).mockResolvedValue([orgARegWebhookFoo]);
      const res = await request(app, 'GET', '/registrations', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('registrations');
      expect(body).toHaveProperty('total');
      expect(body.total).toBe(1);
    });
  });

  // ---- GET /registrations/:id ----

  describe('GET /registrations/:id', () => {
    it('returns registration by ID', async () => {
      (deps.registrationStore.getById as any).mockResolvedValue(sampleRegistration);
      const res = await request(app, 'GET', '/registrations/reg-1', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registration.id).toBe('reg-1');
    });

    it('returns 404 when not found', async () => {
      const res = await request(app, 'GET', '/registrations/nonexistent', { token: validToken });
      expect(res.status).toBe(404);
    });
  });

  // ---- POST /registrations/refresh ----

  describe('POST /registrations/refresh', () => {
    it('bumps registry version and refreshes index', async () => {
      (deps.registrationStore.bumpVersion as any).mockResolvedValue(5);
      const res = await request(app, 'POST', '/registrations/refresh', {
        token: validToken,
        body: { routingKey: 'github:42', repoIdentifier: 'owner/repo' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.registryVersion).toBe(5);
      expect(deps.registrationIndex.refreshIfNeeded).toHaveBeenCalledWith(5);
    });

    it('returns 400 for invalid body', async () => {
      const res = await request(app, 'POST', '/registrations/refresh', {
        token: validToken,
        body: {},
      });
      expect(res.status).toBe(400);
    });
  });

  // ---- DELETE /registrations/:id ----

  describe('DELETE /registrations/:id', () => {
    it('deletes registration and bumps version', async () => {
      // The DELETE path now looks up the row's routing_key first so a
      // scoped token cannot delete a registration outside its scope.
      // Existence has to be mocked alongside the delete itself.
      (deps.registrationStore.getById as any).mockResolvedValue(sampleRegistration);
      (deps.registrationStore.deleteById as any).mockResolvedValue(true);
      (deps.registrationStore.bumpVersion as any).mockResolvedValue(3);
      const res = await request(app, 'DELETE', '/registrations/reg-1', { token: validToken });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
      expect(body.registryVersion).toBe(3);
      expect(deps.registrationIndex.refreshIfNeeded).toHaveBeenCalledWith(3);
    });

    it('returns 404 when registration not found', async () => {
      (deps.registrationStore.getById as any).mockResolvedValue(null);
      (deps.registrationStore.deleteById as any).mockResolvedValue(false);
      const res = await request(app, 'DELETE', '/registrations/nonexistent', {
        token: validToken,
      });
      expect(res.status).toBe(404);
    });
  });

  // ---- POST /registrations/register-manual (satisfiability) ----

  describe('POST /registrations/register-manual', () => {
    // Returns the DB-row shape `matchEnvironment` resolves; the route converts it
    // via `toEnvironment` before the satisfiability check.
    function envRecord(name: string, branchRestrictions: string[]) {
      return {
        id: `id-${name}`,
        org_id: 'cust-1',
        name,
        type: 'fixed',
        glob_pattern: null,
        branch_restrictions: JSON.stringify(branchRestrictions),
        trigger_type_filters: '[]',
        repo_patterns: '[]',
        concurrency_limit: null,
        concurrency_strategy: 'queue',
        concurrency_timeout_ms: 0,
        required_reviewers: null,
        wait_timer_seconds: null,
        hold_expiry_seconds: 3600,
        minimum_trust: null,
        allow_local_execution: false,
        enabled: true,
        created_at: new Date('2026-01-01'),
        updated_at: new Date('2026-01-01'),
        created_by: 'tester',
      };
    }

    function lockBody(envValues: string[]) {
      return {
        repoIdentifier: 'owner/repo',
        routingKey: 'github:42',
        customerId: 'cust-1',
        lockFileContents: JSON.stringify({
          workflows: [
            {
              name: 'ci',
              jobs: [
                {
                  name: 'deploy',
                  environments: envValues.map((v) => ({ value: v, dynamic: false })),
                },
              ],
            },
          ],
        }),
      };
    }

    it('rejects a mutually-exclusive multi-env binding with a precise message', async () => {
      const matchEnvironment = vi.fn(async (_org: string, name: string) =>
        name === 'staging' ? envRecord('staging', ['main']) : envRecord('testing', ['develop']),
      );
      deps = createMockDeps({
        registrationStore: { ...(createMockDeps().registrationStore as any), replaceAll: vi.fn() },
        environmentStore: { matchEnvironment } as any,
      });
      app = createAdminRegistrationRoutes(deps);
      (deps.tokenManager.validate as any).mockResolvedValue({ id: 'u', role: 'owner', label: 't' });

      const res = await request(app, 'POST', '/registrations/register-manual', {
        token: validToken,
        body: lockBody(['staging', 'testing']),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('mutually exclusive');
      expect(deps.registrationStore.replaceAll).not.toHaveBeenCalled();
    });

    it('accepts a satisfiable multi-env binding', async () => {
      const matchEnvironment = vi.fn(async (_org: string, name: string) =>
        envRecord(name, ['main']),
      );
      deps = createMockDeps({
        registrationStore: {
          ...(createMockDeps().registrationStore as any),
          replaceAll: vi.fn(),
          bumpVersion: vi.fn().mockResolvedValue(7),
        },
        environmentStore: { matchEnvironment } as any,
      });
      app = createAdminRegistrationRoutes(deps);
      (deps.tokenManager.validate as any).mockResolvedValue({ id: 'u', role: 'owner', label: 't' });

      const res = await request(app, 'POST', '/registrations/register-manual', {
        token: validToken,
        body: lockBody(['staging', 'testing']),
      });
      expect(res.status).toBe(200);
      expect(deps.registrationStore.replaceAll).toHaveBeenCalled();
    });
  });
});
