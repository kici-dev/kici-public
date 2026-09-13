import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { DrainController } from '../drain/drain-controller.js';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import { createOrchestratorDrainRoutes } from './admin-orchestrator-drain.js';

const ctrl = (active = 0, dispatched = 0) =>
  new DrainController({
    activeJobsTotal: () => active,
    dispatchedJobsOwned: async () => dispatched,
  });

function buildApp(drainController: DrainController, role: Role = 'admin') {
  const inner = createOrchestratorDrainRoutes({ drainController, rbac: new RbacEnforcer() });
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('role' as never, role as never);
    c.set('userId' as never, 'tester' as never);
    c.set('routingKey' as never, null as never);
    await next();
  });
  root.route('/api/v1/admin', inner);
  return root;
}

const path = '/api/v1/admin/orchestrator/drain';

describe('orchestrator drain routes', () => {
  it('GET returns current snapshot', async () => {
    const app = buildApp(ctrl());
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draining: false, jobsRunning: 0 });
  });

  it('POST {action:drain} flips draining on', async () => {
    const c = ctrl();
    const app = buildApp(c);
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'drain' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).draining).toBe(true);
    expect(c.isDraining()).toBe(true);
  });

  it('POST {action:resume} flips draining off', async () => {
    const c = ctrl();
    c.startDrain();
    const app = buildApp(c);
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    });
    expect((await res.json()).draining).toBe(false);
    expect(c.isDraining()).toBe(false);
  });

  it('POST with invalid action is 400', async () => {
    const app = buildApp(ctrl());
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'nope' }),
    });
    expect(res.status).toBe(400);
  });

  it('denies a role without orchestrator.drain (auditor) with 403', async () => {
    const app = buildApp(ctrl(), 'auditor');
    const res = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'drain' }),
    });
    expect(res.status).toBe(403);
  });
});
