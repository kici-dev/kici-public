import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  AccessLogAction,
  AccessLogOutcome,
  AccessLogTargetType,
  PeerForgetOutcome,
  ScalerOrphansAction,
  ScalerVmStatus,
  type ScalerLiveVm,
} from '@kici-dev/engine';
import { RbacEnforcer, type Role } from '../secrets/rbac.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { PeerRegistry } from '../cluster/peer-registry.js';
import {
  disconnectedCoordinatorIds,
  forgetDepartedPeer,
  PeerLivenessWindowKind,
  type PeerForgetResult,
} from '../cluster/peer-forget.js';
import { createPeerForgetRoutes, type PeerForgetRouteDeps } from './admin-peer-forget.js';
import { createScalerOrphansRoutes } from './admin-scaler-orphans.js';

const SELF = 'coord-a';
const FORGET = '/api/v1/admin/peers/forget';

function mount(inner: Hono<never>, opts: { role?: Role; routingKey?: string | null } = {}): Hono {
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

function forgetApp(
  forget: PeerForgetRouteDeps['forget'],
  opts: {
    role?: Role;
    routingKey?: string | null;
    accessLog?: { record: ReturnType<typeof vi.fn> };
  } = {},
): Hono {
  return mount(
    createPeerForgetRoutes({
      peerForget: { forget },
      rbac: new RbacEnforcer(),
      ...(opts.accessLog ? { accessLog: opts.accessLog as unknown as AccessLogWriter } : {}),
    }) as never,
    opts,
  );
}

function post(app: Hono, body: unknown) {
  return app.request(FORGET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const forgotten = (coordinator: string): PeerForgetResult => ({
  coordinator,
  outcome: PeerForgetOutcome.enum.forgotten,
  detail: 'coord-b forgotten',
});

describe('POST /api/v1/admin/peers/forget', () => {
  it('answers one result per coordinator and passes the wait', async () => {
    const forget = vi.fn(async () => [forgotten(SELF), forgotten('coord-c')]);
    const res = await post(forgetApp(forget), { instanceId: 'coord-b', timeoutMs: 5_000 });

    expect(res.status).toBe(200);
    expect(forget).toHaveBeenCalledWith('coord-b', 5_000, false);
    expect(await res.json()).toEqual({
      instanceId: 'coord-b',
      results: [forgotten(SELF), forgotten('coord-c')],
    });
  });

  it('needs peer.manage and an unscoped token', async () => {
    const forget = vi.fn(async () => [forgotten(SELF)]);
    expect((await post(forgetApp(forget, { role: 'auditor' }), { instanceId: 'x' })).status).toBe(
      403,
    );
    expect(
      (await post(forgetApp(forget, { routingKey: 'github:1' }), { instanceId: 'x' })).status,
    ).toBe(403);
    expect(forget).not.toHaveBeenCalled();
  });

  it('rejects a missing id and an out-of-range wait', async () => {
    const forget = vi.fn(async () => [forgotten(SELF)]);
    const app = forgetApp(forget);
    expect((await post(app, {})).status).toBe(400);
    expect((await post(app, { instanceId: 'x', timeoutMs: 60_001 })).status).toBe(400);
    expect(forget).not.toHaveBeenCalled();
  });

  it('answers 409 naming a peer this coordinator still has connected', async () => {
    const forget = vi.fn(async () => [
      {
        coordinator: SELF,
        outcome: PeerForgetOutcome.enum.connected,
        detail: 'coord-b is connected; only a peer that left the cluster can be forgotten',
      },
    ]);
    const res = await post(forgetApp(forget), { instanceId: 'coord-b' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('coord-b is connected');
  });

  it('answers 409 naming a peer heard from inside the stale window', async () => {
    const forget = vi.fn(async () => [
      {
        coordinator: SELF,
        outcome: PeerForgetOutcome.enum.recent,
        detail:
          'coord-b was last heard from 12 s ago (2026-10-02T00:00:00.000Z), inside the 60 s stale window',
      },
    ]);
    const res = await post(forgetApp(forget), { instanceId: 'coord-b' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; acknowledgementRequired?: boolean };
    expect(body.error).toContain('coord-b was last heard from 12 s ago');
    expect(body.acknowledgementRequired).toBeUndefined();
  });

  // fails-when: an HTTP caller forgets the backstop-guarding coordinator without acknowledging it
  it('answers 409 with acknowledgementRequired until the acknowledgement is sent', async () => {
    const forget = vi.fn(async (_id: string, _t: number, ack: boolean) => [
      ack
        ? forgotten(SELF)
        : {
            coordinator: SELF,
            outcome: PeerForgetOutcome.enum['acknowledgement-required'],
            detail: 'coord-b is the last coordinator peer this coordinator knows',
          },
    ]);
    const app = forgetApp(forget);

    const refused = await post(app, { instanceId: 'coord-b' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ acknowledgementRequired: true });

    // breaks-if-wrong: the same forget with the acknowledgement succeeds
    const accepted = await post(app, { instanceId: 'coord-b', acknowledgeBackstop: true });
    expect(accepted.status).toBe(200);
    expect(forget).toHaveBeenLastCalledWith('coord-b', 15_000, true);
  });

  it('answers 404 when no coordinator knows the peer', async () => {
    const notFound = (coordinator: string): PeerForgetResult => ({
      coordinator,
      outcome: PeerForgetOutcome.enum['not-found'],
      detail: 'not here',
    });
    const forget = vi.fn(async () => [notFound(SELF), notFound('coord-c')]);
    const res = await post(forgetApp(forget), { instanceId: 'ghost' });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      'peer ghost is not known to any coordinator',
    );
  });

  it('writes one peer.forget access_log row carrying the results', async () => {
    const accessLog = { record: vi.fn(async () => {}) };
    const results = [forgotten(SELF)];
    await post(
      forgetApp(
        vi.fn(async () => results),
        { accessLog },
      ),
      { instanceId: 'coord-b' },
    );

    expect(accessLog.record).toHaveBeenCalledTimes(1);
    expect(accessLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AccessLogAction.enum['peer.forget'],
        target: { type: AccessLogTargetType.enum.fleet, id: 'coord-b' },
        outcome: AccessLogOutcome.enum.allowed,
        meta: { results, acknowledge_backstop: false },
      }),
    );
  });
});

describe('peer forget unblocks scaler orphans', () => {
  const VM: ScalerLiveVm = {
    vmId: 'scaler-firecracker-lost',
    scaler: 'fc',
    pid: 4242,
    startedAt: new Date(0).toISOString(),
    ageSeconds: 10,
    chrootDir: '/srv/jailer/firecracker/scaler-firecracker-lost/root',
    status: ScalerVmStatus.enum.orphaned,
    trackedBy: [],
    reason: 'orphaned',
  };

  /** A coordinator whose sibling coord-b departed and coord-c stays connected. */
  function cluster() {
    const peers = new PeerRegistry();
    for (const instanceId of ['coord-b', 'coord-c']) {
      peers.addPeer({
        instanceId,
        connectionId: `conn-${instanceId}`,
        address: null,
        routingKeys: [],
        role: 'coordinator',
      });
    }
    peers.markDisconnected('coord-b');
    const orphans = mount(
      createScalerOrphansRoutes({
        orphans: {
          instanceId: SELF,
          role: 'coordinator',
          peerRole: () => undefined,
          answerLocal: async (req) =>
            req.action === ScalerOrphansAction.enum.list
              ? { ok: true, firecrackerScalers: ['fc'], vms: [VM] }
              : { ok: true, results: [] },
          forward: async () => {
            throw new Error('no forward expected');
          },
          findBindings: async () => new Map(),
          findRegistrations: () => new Map(),
          disconnectedCoordinators: () => disconnectedCoordinatorIds(peers, SELF),
        },
        rbac: new RbacEnforcer(),
      }) as never,
    );
    const forget = forgetApp(async (instanceId) => [
      {
        coordinator: SELF,
        ...forgetDepartedPeer(peers, SELF, instanceId, {
          liveness: { kind: PeerLivenessWindowKind.enum['stale-window'], windowMs: 60_000 },
          backstop: null,
          acknowledgeBackstop: false,
          nowMs: Date.now() + 120_000,
        }),
      },
    ]);
    const list = async () =>
      (await (await orphans.request('/api/v1/admin/scaler/orphans')).json()) as {
        node: { disconnectedCoordinators: string[] };
        vms: ScalerLiveVm[];
      };
    return { forget, list };
  }

  // fails-when: the VM stays unverified after its missing coordinator is forgotten
  it('a forgotten coordinator is no longer missing, and the VM is orphaned again', async () => {
    const { forget, list } = cluster();
    const before = await list();
    expect(before.node.disconnectedCoordinators).toEqual(['coord-b']);
    expect(before.vms[0]!.status).toBe(ScalerVmStatus.enum.unverified);

    expect((await post(forget, { instanceId: 'coord-b' })).status).toBe(200);

    const after = await list();
    expect(after.node.disconnectedCoordinators).toEqual([]);
    expect(after.vms[0]!.status).toBe(ScalerVmStatus.enum.orphaned);
  });

  // breaks-if-wrong: a connected coordinator is refused and stays registered
  it('refuses a connected coordinator', async () => {
    const { forget } = cluster();
    const res = await post(forget, { instanceId: 'coord-c' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('coord-c');
  });

  it('answers an unknown id with a clear error', async () => {
    const { forget } = cluster();
    const res = await post(forget, { instanceId: 'ghost' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('ghost');
  });
});
