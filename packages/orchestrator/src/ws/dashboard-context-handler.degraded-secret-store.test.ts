/**
 * An orchestrator running without a pg secret store serves the dashboard from a
 * degraded store. Reads honestly report nothing; writes MUST refuse, because a
 * write that resolves while discarding the value tells the operator a
 * credential is stored when nothing stored it.
 *
 * These tests assert the outcome the dashboard actually observes -- an `error`
 * on the response -- rather than the shape of the store's return value, so a
 * store that silently resolves cannot pass them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardContextHandler } from './dashboard-context-handler.js';
import type { DashboardContextHandlerDeps } from './dashboard-context-handler.js';
import type { DashboardPlatformToOrchMessage } from '@kici-dev/engine';
import { invalidateDashboardWritePolicyCache } from '../policy/dashboard-write-policy.js';
import { createUnavailableSecretStore, type ScopedSecretStore } from '../secrets/scope-routing.js';

/** The store the orchestrator falls back to when it has no pg secret store. */
const degradedStore: ScopedSecretStore = createUnavailableSecretStore();

/** A store that actually records writes, for the non-degraded control. */
function createRecordingStore(): ScopedSecretStore & {
  written: Array<[string, string, string, string]>;
  deleted: Array<[string, string, string]>;
} {
  const written: Array<[string, string, string, string]> = [];
  const deleted: Array<[string, string, string]> = [];
  return {
    written,
    deleted,
    listScopes: async () => ['aws/prod'],
    listKeys: async () => ['API_KEY'],
    setSecret: async (orgId, scope, key, value) => {
      written.push([orgId, scope, key, value]);
    },
    deleteSecret: async (orgId, scope, key) => {
      deleted.push([orgId, scope, key]);
    },
  };
}

function createDeps(secretStore: ScopedSecretStore): DashboardContextHandlerDeps & { sent: any[] } {
  const sent: any[] = [];
  return {
    orgId: 'org-1',
    send: (msg: unknown) => sent.push(msg),
    contextStore: {} as any,
    variableStore: {} as any,
    bindingStore: {} as any,
    secretStore,
    db: {
      selectFrom: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      selectAll: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
      executeTakeFirst: vi.fn().mockResolvedValue(undefined),
    } as any,
    sent,
  };
}

function responseFor(sent: any[], type: string, requestId: string): any {
  return sent.find((m) => m?.type === type && m?.requestId === requestId);
}

describe('degraded secret store refuses dashboard writes', () => {
  beforeEach(() => {
    invalidateDashboardWritePolicyCache();
  });

  it('surfaces an error to the dashboard when a set lands on the degraded store', async () => {
    const deps = createDeps(degradedStore);
    const handler = new DashboardContextHandler(deps);

    const handled = await handler.handleMessage({
      type: 'dashboard.contexts.secrets.set',
      requestId: 'req-degraded-set',
      scope: 'aws/prod',
      key: 'API_KEY',
      value: 'super-secret',
    } as DashboardPlatformToOrchMessage);

    expect(handled).toBe(true);
    const res = responseFor(
      deps.sent,
      'dashboard.contexts.secrets.set.response',
      'req-degraded-set',
    );
    expect(res).toBeDefined();
    expect(res.error).toBeDefined();
    expect(String(res.error)).toMatch(/unavailable/i);
  });

  it('surfaces an error to the dashboard when a delete lands on the degraded store', async () => {
    const deps = createDeps(degradedStore);
    const handler = new DashboardContextHandler(deps);

    const handled = await handler.handleMessage({
      type: 'dashboard.contexts.secrets.delete',
      requestId: 'req-degraded-del',
      scope: 'aws/prod',
      key: 'API_KEY',
    } as DashboardPlatformToOrchMessage);

    expect(handled).toBe(true);
    const res = responseFor(
      deps.sent,
      'dashboard.contexts.secrets.delete.response',
      'req-degraded-del',
    );
    expect(res).toBeDefined();
    expect(res.error).toBeDefined();
    expect(String(res.error)).toMatch(/unavailable/i);
  });

  it('still writes normally when a real store is configured', async () => {
    const store = createRecordingStore();
    const deps = createDeps(store);
    const handler = new DashboardContextHandler(deps);

    await handler.handleMessage({
      type: 'dashboard.contexts.secrets.set',
      requestId: 'req-ok-set',
      scope: 'aws/prod',
      key: 'API_KEY',
      value: 'super-secret',
    } as DashboardPlatformToOrchMessage);

    const res = responseFor(deps.sent, 'dashboard.contexts.secrets.set.response', 'req-ok-set');
    expect(res?.error).toBeUndefined();
    expect(store.written).toEqual([['org-1', 'aws/prod', 'API_KEY', 'super-secret']]);
  });

  it('still deletes normally when a real store is configured', async () => {
    const store = createRecordingStore();
    const deps = createDeps(store);
    const handler = new DashboardContextHandler(deps);

    await handler.handleMessage({
      type: 'dashboard.contexts.secrets.delete',
      requestId: 'req-ok-del',
      scope: 'aws/prod',
      key: 'API_KEY',
    } as DashboardPlatformToOrchMessage);

    const res = responseFor(deps.sent, 'dashboard.contexts.secrets.delete.response', 'req-ok-del');
    expect(res?.error).toBeUndefined();
    expect(store.deleted).toEqual([['org-1', 'aws/prod', 'API_KEY']]);
  });

  // The degraded store leaves the optional scope methods unimplemented, so the
  // scope-CRUD handlers take their unsupported-backend path. That path already
  // refuses; these pin it, because an unimplemented optional method that
  // silently succeeded would be the same defect in a different shape.
  it.each([
    ['create', { type: 'dashboard.contexts.secrets.scope.create', scope: 'aws/prod' }],
    [
      'rename',
      {
        type: 'dashboard.contexts.secrets.scope.rename',
        oldScope: 'aws/prod',
        newScope: 'aws/staging',
      },
    ],
    ['delete', { type: 'dashboard.contexts.secrets.scope.delete', scope: 'aws/prod' }],
  ])('refuses a scope %s against the degraded store', async (label, body) => {
    const deps = createDeps(degradedStore);
    const handler = new DashboardContextHandler(deps);
    const requestId = `req-scope-${label}`;

    await handler.handleMessage({ ...body, requestId } as DashboardPlatformToOrchMessage);

    const res = responseFor(deps.sent, `${body.type}.response`, requestId);
    expect(res).toBeDefined();
    expect(res.error).toBeDefined();
  });

  // The store-level honest-empty guarantee is pinned in
  // `secrets/scope-routing.test.ts`; the list handler skips a backend whose
  // read throws, so only that test can distinguish empty from failing.
  it('renders as an empty secret list rather than an error', async () => {
    const deps = createDeps(degradedStore);
    const handler = new DashboardContextHandler(deps);

    await handler.handleMessage({
      type: 'dashboard.contexts.secrets.list',
      requestId: 'req-degraded-list',
    } as DashboardPlatformToOrchMessage);

    const res = responseFor(
      deps.sent,
      'dashboard.contexts.secrets.list.response',
      'req-degraded-list',
    );
    expect(res).toBeDefined();
    expect(res.error).toBeUndefined();
    expect(res.secrets).toEqual([]);
  });
});

/** Every non-test `.ts` file under the orchestrator source tree. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

describe('no orchestrator source builds a silently-succeeding secret-write stub', () => {
  const srcRoot = fileURLToPath(new URL('..', import.meta.url));
  const serverSource = readFileSync(join(srcRoot, 'server.ts'), 'utf8');

  it('the dashboard secret-store fallback is the shared refusing store', () => {
    expect(serverSource).toContain('sub.pgSecretStore ?? createUnavailableSecretStore()');
  });

  it('no shipped source declares a no-op secret writer', () => {
    const offenders = sourceFiles(srcRoot).filter((file) =>
      /(?:setSecret|deleteSecret):\s*async\s*\([^)]*\)\s*=>\s*\{\s*\}/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
