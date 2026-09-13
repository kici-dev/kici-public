import { describe, it, expect, vi } from 'vitest';
import { createFleetRoutes } from './fleet.js';
import type { TokenManager } from '../secrets/token-manager.js';
import type { FleetTopology } from '../diagnostics/fleet-topology.js';

const topology: FleetTopology = {
  nodes: [{ kind: 'orchestrator', id: 'root', role: 'coordinator', labels: {}, parentId: null }],
};

function fakeTokenManager(valid: boolean): TokenManager {
  return {
    validate: vi.fn(async (t: string) =>
      valid && t === 'good' ? { id: 'u', role: 'admin' } : null,
    ),
  } as unknown as TokenManager;
}

function makeApp(
  opts: {
    valid?: boolean;
    collectBundle?: (o: { selectors: string[] }) => Promise<Buffer>;
  } = {},
) {
  return createFleetRoutes({
    tokenManager: fakeTokenManager(opts.valid ?? true),
    fleet: {
      getTopology: () => topology,
      collectBundle: opts.collectBundle ?? (async () => Buffer.from('PKfleet')),
    },
  });
}

const auth = { Authorization: 'Bearer good' };

describe('fleet admin routes', () => {
  it('GET /admin/fleet-topology returns the topology', async () => {
    const app = makeApp();
    const res = await app.request('/admin/fleet-topology', { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(topology);
  });

  it('POST /admin/fleet-bundle streams the assembled ZIP as application/zip', async () => {
    const collectBundle = vi.fn(async () => Buffer.from('PKbundle'));
    const app = makeApp({ collectBundle });
    const res = await app.request('/admin/fleet-bundle', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectors: ['a', 'b'], logWindowHours: 8, timeoutSeconds: 30 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.toString()).toBe('PKbundle');
    expect(collectBundle).toHaveBeenCalledWith({
      selectors: ['a', 'b'],
      logWindowHours: 8,
      timeoutSeconds: 30,
    });
  });

  it('POST /admin/fleet-bundle defaults to no selectors on an empty body', async () => {
    const collectBundle = vi.fn(async () => Buffer.from('PK'));
    const app = makeApp({ collectBundle });
    const res = await app.request('/admin/fleet-bundle', { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect(collectBundle).toHaveBeenCalledWith({
      selectors: [],
      logWindowHours: undefined,
      timeoutSeconds: undefined,
    });
  });

  it('returns 401 without a valid token', async () => {
    const app = makeApp({ valid: false });
    const res = await app.request('/admin/fleet-topology', {
      headers: { Authorization: 'Bearer bad' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 without an Authorization header', async () => {
    const app = makeApp();
    const res = await app.request('/admin/fleet-topology');
    expect(res.status).toBe(401);
  });

  it('does not auth-gate paths outside /admin/fleet-* (no global * middleware)', async () => {
    // This router is mounted at '/' on the orchestrator app. A '*' auth
    // matcher would attach the Bearer gate to unrelated routes like /health
    // and 401 them. With the path-scoped middleware, an unrelated path is a
    // plain 404 (router has no handler) — NOT a 401 (auth intercepting it).
    const app = makeApp();
    const res = await app.request('/health');
    expect(res.status).toBe(404);
  });

  it('returns 500 when collection throws', async () => {
    const app = makeApp({
      collectBundle: async () => {
        throw new Error('mesh exploded');
      },
    });
    const res = await app.request('/admin/fleet-bundle', { method: 'POST', headers: auth });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('mesh exploded');
  });
});
