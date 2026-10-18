import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createAdminQueueExecutionRoutes } from './admin-queue-execution.js';
import { RbacEnforcer } from '../secrets/rbac.js';
import type { AdminEnv } from './admin-env.js';

/** The routes behind an auth stand-in that sets an owner role, as admin.ts does. */
function app(execute: ReturnType<typeof vi.fn>) {
  const outer = new Hono<AdminEnv>();
  outer.use('*', async (c, next) => {
    c.set('role', 'owner');
    await next();
  });
  outer.route(
    '/',
    createAdminQueueExecutionRoutes({
      db: {
        getExecutor: () => ({
          transformQuery: (node: unknown) => node,
          compileQuery: () => ({ sql: '', parameters: [] }),
          executeQuery: execute,
        }),
      } as never,
      rbac: new RbacEnforcer(),
    }),
  );
  return outer;
}

describe('GET /executions/:runId', () => {
  it('refuses a run id that is not a full UUID with a 400 naming it, before any query', async () => {
    const execute = vi.fn();
    const res = await app(execute).request('/executions/709c899a');
    // fails-when: the short id reaches the uuid column and fails as a malformed value
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid run id '709c899a': a run id is a full UUID.");
    expect(execute).not.toHaveBeenCalled();
  });

  it('looks up a full run id', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const res = await app(execute).request('/executions/709C899A-B06F-45D0-A3E2-D0A14FA62094');
    // breaks-if-wrong: a full id, in either case, still reaches the query
    expect(res.status).toBe(404);
    expect(execute).toHaveBeenCalled();
  });
});
