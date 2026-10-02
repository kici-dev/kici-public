import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogSource,
  AccessLogTargetType,
  ActorType,
  ScalerOrphansAction,
  ScalerVmStatus,
  ScalerVmStopOutcome,
  ScalerVmTracker,
  type ScalerLiveVm,
} from '@kici-dev/engine';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import { ScalerOrphansForwardFailure } from '../cluster/scaler-orphans-peer.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { createScalerOrphansRoutes, type ScalerOrphansRouteDeps } from './admin-scaler-orphans.js';

const SELF = 'coord-a';

function liveVm(vmId: string): ScalerLiveVm {
  return {
    vmId,
    scaler: 'fc',
    pid: 4242,
    startedAt: new Date(0).toISOString(),
    ageSeconds: 10,
    chrootDir: `/srv/jailer/firecracker/${vmId}/root`,
    status: ScalerVmStatus.enum.orphaned,
    trackedBy: [],
    reason: 'orphaned',
  };
}

function fakeDeps(over: Partial<ScalerOrphansRouteDeps> = {}) {
  const deps = {
    instanceId: SELF,
    role: 'coordinator' as const,
    peerRole: vi.fn((): 'coordinator' | 'worker' | undefined => 'worker'),
    answerLocal: vi.fn(async (req: { action: ScalerOrphansAction; vmIds?: string[] }) =>
      req.action === ScalerOrphansAction.enum.list
        ? { ok: true, firecrackerScalers: ['fc'], vms: [liveVm('vm-a'), liveVm('vm-b')] }
        : {
            ok: true,
            firecrackerScalers: ['fc'],
            results: (req.vmIds ?? []).map((vmId) => ({
              vmId,
              outcome: ScalerVmStopOutcome.enum.stopped,
              pid: 4242,
              detail: 'stopped',
            })),
          },
    ),
    forward: vi.fn(async (): Promise<Awaited<ReturnType<ScalerOrphansRouteDeps['forward']>>> => ({
      type: 'peer.scaler.orphans.response',
      messageId: 'm',
      ok: true,
      firecrackerScalers: ['fc-arm'],
      vms: [liveVm('vm-w')],
    })),
    findBindings: vi.fn(async () => new Map<string, string>()),
    findRegistrations: vi.fn(() => new Map<string, string>()),
    disconnectedCoordinators: vi.fn((): string[] => []),
    ...over,
  };
  return deps;
}

function buildApp(
  deps: ScalerOrphansRouteDeps,
  opts: {
    role?: Role;
    routingKey?: string | null;
    accessLog?: { record: ReturnType<typeof vi.fn> };
  } = {},
) {
  const inner = createScalerOrphansRoutes({
    orphans: deps,
    rbac: new RbacEnforcer(),
    ...(opts.accessLog ? { accessLog: opts.accessLog as unknown as AccessLogWriter } : {}),
  });
  const root = new Hono();
  root.use('*', async (c, next) => {
    c.set('role' as never, (opts.role ?? 'admin') as never);
    c.set('userId' as never, 'token-user' as never);
    c.set('routingKey' as never, (opts.routingKey ?? null) as never);
    await next();
  });
  root.route('/api/v1/admin', inner);
  return root;
}

const LIST = '/api/v1/admin/scaler/orphans';
const STOP = '/api/v1/admin/scaler/orphans/stop';

function post(app: Hono, body: unknown) {
  return app.request(STOP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('scaler orphans routes', () => {
  it('an auditor lists but may not stop', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps, { role: 'auditor' });

    expect((await app.request(LIST)).status).toBe(200);
    expect((await post(app, { vmIds: ['vm-a'] })).status).toBe(403);
    expect(deps.answerLocal).toHaveBeenCalledTimes(1);
  });

  // breaks-if-wrong: an admin may stop
  it('an admin stops an unbound VM on this coordinator', async () => {
    const deps = fakeDeps();
    const res = await post(buildApp(deps), { vmIds: ['vm-a'] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      node: {
        instanceId: SELF,
        role: 'coordinator',
        firecrackerScalers: ['fc'],
        disconnectedCoordinators: [],
      },
      results: [
        { vmId: 'vm-a', outcome: ScalerVmStopOutcome.enum.stopped, pid: 4242, detail: 'stopped' },
      ],
    });
  });

  it('a routing-key-scoped token is refused on both routes', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps, { routingKey: 'github:1' });

    expect((await app.request(LIST)).status).toBe(403);
    expect((await post(app, { vmIds: ['vm-a'] })).status).toBe(403);
    expect(deps.answerLocal).not.toHaveBeenCalled();
  });

  it('marks a VM whose agent holds a live job as tracked by that job', async () => {
    const deps = fakeDeps({ findBindings: vi.fn(async () => new Map([['vm-b', 'job-7']])) });
    const res = await buildApp(deps).request(LIST);
    const body = (await res.json()) as { vms: ScalerLiveVm[] };

    expect(body.vms.find((vm) => vm.vmId === 'vm-a')!.status).toBe(ScalerVmStatus.enum.orphaned);
    expect(body.vms.find((vm) => vm.vmId === 'vm-b')).toMatchObject({
      status: ScalerVmStatus.enum.tracked,
      trackedBy: [ScalerVmTracker.enum['bound-job']],
      reason: expect.stringContaining('job-7'),
    });
  });

  // fails-when: a bound id is forwarded to the node
  it('never sends a bound VM to the node, and stops the unbound one in the same request', async () => {
    const deps = fakeDeps({ findBindings: vi.fn(async () => new Map([['vm-b', 'job-7']])) });
    const res = await post(buildApp(deps), { vmIds: ['vm-a', 'vm-b'] });

    expect(deps.answerLocal).toHaveBeenCalledWith({
      action: ScalerOrphansAction.enum.stop,
      vmIds: ['vm-a'],
    });
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([
      expect.objectContaining({ vmId: 'vm-a', outcome: ScalerVmStopOutcome.enum.stopped }),
      { vmId: 'vm-b', outcome: ScalerVmStopOutcome.enum.tracked, detail: 'bound to job job-7' },
    ]);
  });

  // fails-when: an agent registered with an HA sibling leaves its VM stoppable on this node
  it('treats a VM whose agent is registered with a cluster peer as tracked', async () => {
    const deps = fakeDeps({
      findRegistrations: vi.fn(() => new Map([['vm-b', 'coord-b']])),
    });
    const app = buildApp(deps);

    const listed = (await (await app.request(LIST)).json()) as { vms: ScalerLiveVm[] };
    expect(listed.vms.find((vm) => vm.vmId === 'vm-b')).toMatchObject({
      status: ScalerVmStatus.enum.tracked,
      trackedBy: [ScalerVmTracker.enum.registered],
      reason: expect.stringContaining('coord-b'),
    });

    const res = await post(app, { vmIds: ['vm-a', 'vm-b'] });
    expect(deps.answerLocal).toHaveBeenLastCalledWith({
      action: ScalerOrphansAction.enum.stop,
      vmIds: ['vm-a'],
    });
    expect(((await res.json()) as { results: unknown[] }).results).toContainEqual({
      vmId: 'vm-b',
      outcome: ScalerVmStopOutcome.enum.tracked,
      detail: 'agent registered with coord-b',
    });
  });

  // fails-when: a VM is stopped while a sibling coordinator, which may hold its agent, is unreachable
  it('lists every candidate as unverified and stops none while a coordinator peer is disconnected', async () => {
    const deps = fakeDeps({ disconnectedCoordinators: vi.fn(() => ['coord-b']) });
    const app = buildApp(deps);

    const listed = (await (await app.request(LIST)).json()) as {
      node: { disconnectedCoordinators: string[] };
      vms: ScalerLiveVm[];
    };
    expect(listed.node.disconnectedCoordinators).toEqual(['coord-b']);
    for (const vm of listed.vms) {
      expect(vm.status).toBe(ScalerVmStatus.enum.unverified);
      expect(vm.reason).toContain('coord-b');
    }

    const res = await post(app, { vmIds: ['vm-a'] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([
      {
        vmId: 'vm-a',
        outcome: ScalerVmStopOutcome.enum.unverified,
        detail: expect.stringContaining('coord-b'),
      },
    ]);
    expect(deps.answerLocal).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: ScalerOrphansAction.enum.stop }),
    );
  });

  // breaks-if-wrong: with every coordinator connected the classification is unchanged
  it('keeps an untracked VM orphaned while every coordinator peer is connected', async () => {
    const deps = fakeDeps();
    const listed = (await (await buildApp(deps).request(LIST)).json()) as { vms: ScalerLiveVm[] };
    expect(listed.vms.map((vm) => vm.status)).toEqual([
      ScalerVmStatus.enum.orphaned,
      ScalerVmStatus.enum.orphaned,
    ]);
  });

  it('does not ask the node at all when every VM is bound', async () => {
    const deps = fakeDeps({ findBindings: vi.fn(async () => new Map([['vm-b', 'job-7']])) });
    const res = await post(buildApp(deps), { vmIds: ['vm-b'] });

    expect(res.status).toBe(200);
    expect(deps.answerLocal).not.toHaveBeenCalled();
  });

  it('a target equal to this instance answers locally', async () => {
    const deps = fakeDeps();
    await buildApp(deps).request(`${LIST}?target=${SELF}`);

    expect(deps.answerLocal).toHaveBeenCalled();
    expect(deps.forward).not.toHaveBeenCalled();
  });

  it('another target is forwarded with the default wait and named with its role', async () => {
    const deps = fakeDeps();
    const res = await buildApp(deps).request(`${LIST}?target=worker-1`);

    expect(deps.forward).toHaveBeenCalledWith(
      'worker-1',
      { action: ScalerOrphansAction.enum.list },
      30_000,
    );
    expect(await res.json()).toMatchObject({
      node: { instanceId: 'worker-1', role: 'worker', firecrackerScalers: ['fc-arm'] },
      vms: [expect.objectContaining({ vmId: 'vm-w' })],
    });
  });

  it('forwards the requested wait', async () => {
    const deps = fakeDeps();
    await post(buildApp(deps), { target: 'worker-1', vmIds: ['vm-w'], timeoutMs: 45_000 });

    expect(deps.forward).toHaveBeenCalledWith(
      'worker-1',
      { action: ScalerOrphansAction.enum.stop, vmIds: ['vm-w'] },
      45_000,
    );
  });

  it('maps an unconnected peer to 404, a silent one to 504 and a failing one to 502', async () => {
    const cases = [
      [ScalerOrphansForwardFailure.enum['not-connected'], 404, 'not connected'],
      [ScalerOrphansForwardFailure.enum.timeout, 504, 'may run a version without this request'],
      [
        {
          type: 'peer.scaler.orphans.response',
          messageId: 'm',
          ok: false,
          error: 'readdir failed',
        },
        502,
        'readdir failed',
      ],
    ] as const;
    for (const [answer, status, message] of cases) {
      const deps = fakeDeps({ forward: vi.fn(async () => answer) as never });
      const res = await buildApp(deps).request(`${LIST}?target=worker-1`);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toContain(message);
    }
  });

  it('rejects an empty or oversized id list and an out-of-range wait', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const ids = Array.from({ length: 101 }, (_, i) => `vm-${i}`);

    expect((await post(app, { vmIds: [] })).status).toBe(400);
    expect((await post(app, { vmIds: ids })).status).toBe(400);
    expect((await post(app, { vmIds: ['vm-a'], timeoutMs: 999 })).status).toBe(400);
    expect((await post(app, { vmIds: ['vm-a'], timeoutMs: 240_001 })).status).toBe(400);
    expect((await app.request(`${LIST}?timeoutMs=0`)).status).toBe(400);
    expect(deps.answerLocal).not.toHaveBeenCalled();
    // Positive control: the bounds themselves are accepted.
    expect((await post(app, { vmIds: ids.slice(0, 100), timeoutMs: 1_000 })).status).toBe(200);
  });

  it('writes one access_log row per stop, carrying the results', async () => {
    const accessLog = { record: vi.fn(async () => {}) };
    const deps = fakeDeps();
    const res = await post(buildApp(deps, { accessLog }), { vmIds: ['vm-a'] });
    const { results } = (await res.json()) as { results: unknown[] };

    expect(accessLog.record).toHaveBeenCalledTimes(1);
    expect(accessLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AccessLogAction.enum['scaler.orphan.stop'],
        target: { type: AccessLogTargetType.enum.scaler, id: SELF },
        source: AccessLogSource.enum.admin_http,
        outcome: AccessLogOutcome.enum.allowed,
        actor: { type: ActorType.enum.service_account, id: 'token-user' },
        meta: { target: SELF, vm_ids: ['vm-a'], results },
      }),
    );
  });

  it('records a failed forward as an error row', async () => {
    const accessLog = { record: vi.fn(async () => {}) };
    const deps = fakeDeps({
      forward: vi.fn(async () => ScalerOrphansForwardFailure.enum.timeout) as never,
    });
    await post(buildApp(deps, { accessLog }), { target: 'worker-1', vmIds: ['vm-w'] });

    expect(accessLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AccessLogAction.enum['scaler.orphan.stop'],
        outcome: AccessLogOutcome.enum.error,
      }),
    );
  });

  it('records a listing as scaler.orphans.read', async () => {
    const accessLog = { record: vi.fn(async () => {}) };
    await buildApp(fakeDeps(), { accessLog }).request(LIST);

    expect(accessLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AccessLogAction.enum['scaler.orphans.read'],
        target: { type: AccessLogTargetType.enum.scaler, id: SELF },
      }),
    );
  });
});
