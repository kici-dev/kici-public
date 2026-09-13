/**
 * Per-file adoption sweep for the shared admin bearer-auth boundary.
 *
 * `routes/admin-auth.test.ts` proves the boundary itself behaves: a lookup that
 * cannot complete becomes a structured 503 instead of an unhandled throw. That
 * says nothing about whether a given admin router actually routes through it.
 * A router carrying its own `await deps.tokenManager.validate(token)` with no
 * `try`/`catch` compiles, passes every per-file test, and still answers a
 * database fault with a bare 500.
 *
 * So this sweep drives each DB-backed admin router end-to-end with a validator
 * that throws, and asserts the boundary's own 503 body. The assertion can only
 * hold when the router uses the shared factory: a hand-rolled middleware lets
 * the throw escape, and Hono's default handler answers 500 with no JSON body.
 * A future admin router that reintroduces its own copy fails here.
 *
 * Non-auth dependencies are deliberately absent -- the request is answered
 * inside the middleware, so no handler ever reads them.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Hono } from 'hono';

import { AUTH_ERROR } from './admin-auth.js';
import { createAdminRoutes } from './admin.js';
import { createAdminRunRoutes } from './admin-runs.js';
import { createAdminEventDlqRoutes } from './admin-event-dlq.js';
import { createAdminEventLogRoutes } from './admin-event-log.js';
import { createAdminEventRoutes } from './admin-events.js';
import { createAdminAccessLogRoutes } from './admin-access-log.js';
import { createAdminRegistrationRoutes } from './admin-registrations.js';
import { createAdminScheduledJobsRoutes } from './admin-scheduled-jobs.js';
import { createFleetRoutes } from './fleet.js';

/** A TokenManager stub whose lookup fails the way an unreachable database does. */
function throwingTokenManager() {
  return {
    validate: vi.fn(async () => {
      throw new Error('connection terminated unexpectedly');
    }),
  } as any;
}

/**
 * One router under test: its factory bound to a throwing validator, plus a
 * path the router's auth middleware guards.
 */
interface AdoptionCase {
  name: string;
  build: (tokenManager: ReturnType<typeof throwingTokenManager>) => Hono<any>;
  method: string;
  path: string;
}

const cases: AdoptionCase[] = [
  {
    name: 'admin.ts',
    build: (tokenManager) => createAdminRoutes({ tokenManager } as any),
    method: 'GET',
    path: '/api/v1/admin/tokens',
  },
  {
    name: 'admin-runs.ts',
    build: (tokenManager) => createAdminRunRoutes({ tokenManager } as any),
    method: 'GET',
    path: '/api/v1/admin/runs',
  },
  {
    name: 'admin-events.ts',
    build: (tokenManager) => createAdminEventRoutes({ tokenManager } as any),
    method: 'GET',
    path: '/api/v1/admin/generic-sources',
  },
  {
    name: 'admin-event-log.ts',
    build: (tokenManager) => createAdminEventLogRoutes({ tokenManager } as any),
    method: 'GET',
    path: '/api/v1/admin/event-log',
  },
  {
    name: 'admin-event-dlq.ts',
    build: (tokenManager) => createAdminEventDlqRoutes({ tokenManager } as any),
    method: 'GET',
    path: '/api/v1/admin/event-dlq',
  },
  {
    name: 'admin-access-log.ts',
    build: (tokenManager) => createAdminAccessLogRoutes({ tokenManager } as any),
    method: 'GET',
    path: '/api/v1/admin/access-log',
  },
  {
    name: 'admin-registrations.ts',
    build: (tokenManager) => createAdminRegistrationRoutes({ tokenManager } as any),
    method: 'GET',
    path: '/api/v1/admin/registrations',
  },
  {
    name: 'admin-scheduled-jobs.ts',
    build: (tokenManager) => createAdminScheduledJobsRoutes({ tokenManager } as any),
    method: 'POST',
    path: '/api/v1/admin/scheduled-jobs/some-job/trigger',
  },
  {
    name: 'fleet.ts',
    build: (tokenManager) => createFleetRoutes({ tokenManager } as any),
    method: 'GET',
    path: '/admin/fleet-topology',
  },
];

describe('admin auth boundary adoption sweep', () => {
  for (const tc of cases) {
    it(`${tc.name} answers an undecidable lookup with 503, not 500`, async () => {
      const tokenManager = throwingTokenManager();
      const app = tc.build(tokenManager);

      const res = await app.request(`http://localhost${tc.path}`, {
        method: tc.method,
        headers: { Authorization: 'Bearer some-real-looking-token' },
      });

      expect(res.status, `${tc.name} must answer 503, got ${res.status}`).toBe(503);
      expect(await res.json()).toEqual({ error: AUTH_ERROR.unavailable });
      expect(tokenManager.validate).toHaveBeenCalledTimes(1);
    });

    it(`${tc.name} still answers a rejected credential with 401`, async () => {
      const tokenManager = { validate: vi.fn(async () => null) } as any;
      const app = tc.build(tokenManager);

      const res = await app.request(`http://localhost${tc.path}`, {
        method: tc.method,
        headers: { Authorization: 'Bearer nope-not-a-token' },
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: AUTH_ERROR.invalid });
    });
  }
});
