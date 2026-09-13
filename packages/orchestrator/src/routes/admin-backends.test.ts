import { describe, it, expect, vi } from 'vitest';
import { createBackendRoutes } from './admin-backends.js';
import type { BackendRegistry } from '../secrets/backend-registry.js';
import type { BackendHealthChecker } from '../secrets/backend-health.js';

function createDeps(overrides?: {
  getBackend?: ReturnType<typeof vi.fn>;
  removeBackend?: ReturnType<typeof vi.fn>;
}) {
  const getBackend = overrides?.getBackend ?? vi.fn().mockResolvedValue(null);
  const removeBackend = overrides?.removeBackend ?? vi.fn().mockResolvedValue(false);
  const registry = {
    addBackend: vi.fn(),
    listBackends: vi.fn().mockResolvedValue([]),
    getBackend,
    getBackendConfig: vi.fn().mockResolvedValue(null),
    removeBackend,
  } as unknown as BackendRegistry;
  const healthChecker = {
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
  } as unknown as BackendHealthChecker;
  const syncManager = {
    syncAllBackends: vi.fn().mockResolvedValue([]),
    syncBackend: vi.fn().mockResolvedValue({ scopeCount: 0 }),
  } as unknown as Parameters<typeof createBackendRoutes>[0]['syncManager'];
  return { registry, healthChecker, syncManager, getBackend, removeBackend };
}

// A backend name is a single already-decoded Hono path param. The handlers must
// NOT decode it a second time — a second decode either throws a URIError (500)
// when the literal name carries a stray `%`, or silently collapses a
// `%NN`-looking name onto a DIFFERENT backend (wrong-backend read/mutation).
// `addBackendSchema` puts no charset restriction on `name`, so a backend
// literally named `100%done` is creatable and both failure modes are reachable.
describe('backend :name path param is decoded exactly once (no double-decode)', () => {
  it('GET /backends/:name forwards a literal-% name verbatim (was a 500)', async () => {
    const deps = createDeps();
    const app = createBackendRoutes(deps);

    // URL segment `100%25done` decodes (once, by Hono) to the literal `100%done`.
    const res = await app.request('/backends/100%25done');

    expect(res.status).toBe(404);
    expect(deps.getBackend).toHaveBeenCalledWith('100%done');
  });

  it('DELETE /backends/:name forwards a literal-% name verbatim', async () => {
    const deps = createDeps();
    const app = createBackendRoutes(deps);

    const res = await app.request('/backends/100%25done', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(deps.getBackend).toHaveBeenCalledWith('100%done');
  });

  it('POST /backends/:name/test forwards a literal-% name verbatim', async () => {
    const deps = createDeps();
    const app = createBackendRoutes(deps);

    const res = await app.request('/backends/100%25done/test', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(deps.getBackend).toHaveBeenCalledWith('100%done');
  });

  it('POST /backends/:name/sync forwards a literal-% name verbatim', async () => {
    const deps = createDeps();
    const app = createBackendRoutes(deps);

    const res = await app.request('/backends/100%25done/sync', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(deps.getBackend).toHaveBeenCalledWith('100%done');
  });

  it('does not collapse a %NN-looking name onto a different backend', async () => {
    const deps = createDeps();
    const app = createBackendRoutes(deps);

    // URL `a%2520b` → Hono decodes ONCE → `a%20b` (a five-char backend name). A
    // second decode would wrongly yield `a b` and target a different backend.
    const res = await app.request('/backends/a%2520b');

    expect(res.status).toBe(404);
    expect(deps.getBackend).toHaveBeenCalledWith('a%20b');
    expect(deps.getBackend).not.toHaveBeenCalledWith('a b');
  });
});
