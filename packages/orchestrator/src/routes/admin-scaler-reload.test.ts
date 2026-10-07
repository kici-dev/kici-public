import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogTargetType,
  ScalerReloadOutcome,
  type ScalerReloadInstanceResult,
  type ScalerReloadPlan,
} from '@kici-dev/engine';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import {
  createScalerReloadRoutes,
  DEFAULT_SCALER_RELOAD_TIMEOUT_MS,
  type ScalerReloadRouteDeps,
} from './admin-scaler-reload.js';

const SELF = 'coord-a';
const RELOAD = '/api/v1/admin/scaler/reload';

const plan: ScalerReloadPlan = {
  added: [],
  updated: ['linux'],
  unchanged: ['gpu'],
  retired: [],
  resurrected: [],
  global: [],
};

const result = (
  instanceId: string,
  outcome: ScalerReloadOutcome,
  extra: Partial<ScalerReloadInstanceResult> = {},
): ScalerReloadInstanceResult => ({ instanceId, role: 'coordinator', outcome, ...extra });

function reloadApp(
  reload: ScalerReloadRouteDeps['reload'],
  opts: {
    role?: Role;
    routingKey?: string | null;
    accessLog?: { record: ReturnType<typeof vi.fn> };
  } = {},
): Hono {
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('role' as never, (opts.role ?? 'admin') as never);
    c.set('userId' as never, 'token-user' as never);
    c.set('routingKey' as never, (opts.routingKey ?? null) as never);
    await next();
  });
  root.route(
    '/api/v1/admin',
    createScalerReloadRoutes({
      scalerReload: { instanceId: SELF, reload },
      rbac: new RbacEnforcer(),
      ...(opts.accessLog ? { accessLog: opts.accessLog as unknown as AccessLogWriter } : {}),
    }) as never,
  );
  return root;
}

function post(app: Hono, body: unknown) {
  return app.request(RELOAD, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/admin/scaler/reload', () => {
  // breaks-if-wrong: owner and admin with an unscoped token still reload
  it.each(['owner', 'admin'] as const)('reloads across the cluster for %s', async (role) => {
    const results = [
      result(SELF, ScalerReloadOutcome.enum.applied, { plan }),
      result('worker-b', ScalerReloadOutcome.enum['not-configured'], { role: 'worker' }),
    ];
    const reload = vi.fn(async () => results);
    const res = await post(reloadApp(reload, { role }), {});

    expect(res.status).toBe(200);
    expect(reload).toHaveBeenCalledWith(false, DEFAULT_SCALER_RELOAD_TIMEOUT_MS);
    expect(await res.json()).toEqual({ scope: 'cluster', results });
  });

  // fails-when: the requireUnscoped or the scaler.manage check is dropped
  it('needs scaler.manage and an unscoped token', async () => {
    const reload = vi.fn(async () => [result(SELF, ScalerReloadOutcome.enum.applied)]);
    expect((await post(reloadApp(reload, { role: 'auditor' }), {})).status).toBe(403);
    expect((await post(reloadApp(reload, { routingKey: 'github:1' }), {})).status).toBe(403);
    expect(reload).not.toHaveBeenCalled();
  });

  it('single reloads this orchestrator only, with the wait it was given', async () => {
    const reload = vi.fn(async () => [result(SELF, ScalerReloadOutcome.enum.applied)]);
    const res = await post(reloadApp(reload), { single: true, timeoutMs: 5_000 });

    expect(res.status).toBe(200);
    expect(reload).toHaveBeenCalledWith(true, 5_000);
    expect(((await res.json()) as { scope: string }).scope).toBe('single');
  });

  // fails-when: a refused file or an unreached peer answers 200
  it.each([ScalerReloadOutcome.enum.rejected, ScalerReloadOutcome.enum.unreachable])(
    'answers 422 with every result when one instance is %s',
    async (outcome) => {
      const results = [
        result(SELF, ScalerReloadOutcome.enum.applied, { plan }),
        result('coord-b', outcome, { errors: ['overlap'] }),
      ];
      const res = await post(reloadApp(vi.fn(async () => results)), {});

      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ scope: 'cluster', results });
    },
  );

  it('rejects a malformed body', async () => {
    const reload = vi.fn(async () => [result(SELF, ScalerReloadOutcome.enum.applied)]);
    const app = reloadApp(reload);
    expect((await post(app, { single: 'yes' })).status).toBe(400);
    expect((await post(app, { timeoutMs: 10 })).status).toBe(400);
    expect((await post(app, { timeoutMs: 240_001 })).status).toBe(400);
    expect(reload).not.toHaveBeenCalled();
  });

  it('records one access-log row per request, allowed or error', async () => {
    const accessLog = { record: vi.fn(async () => undefined) };
    const ok = [result(SELF, ScalerReloadOutcome.enum.applied, { plan })];
    await post(
      reloadApp(
        vi.fn(async () => ok),
        { accessLog },
      ),
      { single: true },
    );
    const refused = [result(SELF, ScalerReloadOutcome.enum.rejected, { errors: ['overlap'] })];
    await post(
      reloadApp(
        vi.fn(async () => refused),
        { accessLog },
      ),
      {},
    );

    expect(accessLog.record).toHaveBeenCalledTimes(2);
    expect(accessLog.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: AccessLogAction.enum['scaler.reload'],
        target: { type: AccessLogTargetType.enum.scaler, id: SELF },
        outcome: AccessLogOutcome.enum.allowed,
        meta: { single: true, results: ok },
      }),
    );
    expect(accessLog.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        outcome: AccessLogOutcome.enum.error,
        errorMessage: `scaler reload rejected on ${SELF}`,
        meta: { single: false, results: refused },
      }),
    );
  });
});
