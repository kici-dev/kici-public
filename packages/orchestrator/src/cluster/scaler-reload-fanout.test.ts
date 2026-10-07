import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ScalerReloadOutcome,
  type PeerScalerReloadResponse,
  type ScalerReloadPlan,
} from '@kici-dev/engine';
import { reloadScalersAcrossCluster, type SendScalerReload } from './scaler-reload-fanout.js';
import type { PeerInfo } from './peer-registry.js';

const plan: ScalerReloadPlan = {
  added: [],
  updated: ['linux'],
  unchanged: [],
  retired: [],
  resurrected: [],
  global: [],
};

function peer(instanceId: string, role: PeerInfo['role'], connected = true): PeerInfo {
  return { instanceId, role, connected } as PeerInfo;
}

function registry(peers: PeerInfo[]) {
  return { getAllPeers: () => peers };
}

const applied = async () => ({ outcome: ScalerReloadOutcome.enum.applied, plan });

function answer(messageId: string, extra: Partial<PeerScalerReloadResponse> = {}) {
  return {
    type: 'peer.scaler.reload.response' as const,
    messageId,
    outcome: ScalerReloadOutcome.enum.applied,
    plan,
    ...extra,
  };
}

const base = { selfInstanceId: 'coord-a', selfRole: 'coordinator' as const, timeoutMs: 1_000 };

describe('reloadScalersAcrossCluster', () => {
  // breaks-if-wrong: a lone orchestrator returns its own result
  it('a lone orchestrator returns its own result', async () => {
    const send = vi.fn();
    expect(
      await reloadScalersAcrossCluster({
        ...base,
        registry: registry([]),
        local: applied,
        send,
        single: false,
      }),
    ).toEqual([
      {
        instanceId: 'coord-a',
        role: 'coordinator',
        outcome: ScalerReloadOutcome.enum.applied,
        plan,
      },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  // fails-when: a connected peer is skipped, or a worker is left out
  it('reloads every connected peer, coordinators and workers, this one first', async () => {
    const send: SendScalerReload = vi.fn(async (instanceId, msg) =>
      instanceId === 'worker-b'
        ? answer(msg.messageId, {
            outcome: ScalerReloadOutcome.enum['not-configured'],
            plan: undefined,
          })
        : answer(msg.messageId),
    );
    const results = await reloadScalersAcrossCluster({
      ...base,
      registry: registry([peer('worker-b', 'worker'), peer('coord-c', 'coordinator')]),
      local: applied,
      send,
      single: false,
    });

    expect(results).toEqual([
      { instanceId: 'coord-a', role: 'coordinator', outcome: 'applied', plan },
      { instanceId: 'coord-c', role: 'coordinator', outcome: 'applied', plan },
      { instanceId: 'worker-b', role: 'worker', outcome: 'not-configured', plan: undefined },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  // fails-when: --single sends to a peer
  it('single reloads only this orchestrator', async () => {
    const send = vi.fn();
    const results = await reloadScalersAcrossCluster({
      ...base,
      registry: registry([peer('coord-c', 'coordinator')]),
      local: applied,
      send,
      single: true,
    });
    expect(results.map((r) => r.instanceId)).toEqual(['coord-a']);
    expect(send).not.toHaveBeenCalled();
  });

  // fails-when: a known, disconnected peer is silently left out of the result
  it('reports a known disconnected peer unreachable without sending to it', async () => {
    const send = vi.fn();
    const [, gone] = await reloadScalersAcrossCluster({
      ...base,
      registry: registry([peer('coord-gone', 'coordinator', false)]),
      local: applied,
      send,
      single: false,
    });
    expect(gone).toMatchObject({
      instanceId: 'coord-gone',
      outcome: ScalerReloadOutcome.enum.unreachable,
    });
    expect(gone.detail).toContain('kici-admin peer forget coord-gone');
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a peer no connection reached, and one that did not answer, unreachable', async () => {
    const send: SendScalerReload = vi.fn(async (instanceId) =>
      instanceId === 'coord-b' ? null : ('timeout' as const),
    );
    const [, b, c] = await reloadScalersAcrossCluster({
      ...base,
      registry: registry([peer('coord-b', 'coordinator'), peer('coord-c', 'coordinator')]),
      local: applied,
      send,
      single: false,
    });
    expect(b).toMatchObject({
      outcome: ScalerReloadOutcome.enum.unreachable,
      detail: 'no connection reached this orchestrator',
    });
    expect(c).toMatchObject({ outcome: ScalerReloadOutcome.enum.unreachable });
    expect(c.detail).toContain('no answer within 1000 ms');
  });

  describe('timing', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('starts the local reload and the peer requests together', async () => {
      const started: string[] = [];
      let finishLocal!: () => void;
      const local = vi.fn(
        () =>
          new Promise<{ outcome: ScalerReloadOutcome }>((resolve) => {
            started.push('local');
            finishLocal = () => resolve({ outcome: ScalerReloadOutcome.enum.applied });
          }),
      );
      const send: SendScalerReload = vi.fn(async (instanceId, msg) => {
        started.push(instanceId);
        return answer(msg.messageId);
      });

      const pending = reloadScalersAcrossCluster({
        ...base,
        registry: registry([peer('coord-b', 'coordinator')]),
        local,
        send,
        single: false,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual(['local', 'coord-b']);
      finishLocal();
      expect((await pending).map((r) => r.outcome)).toEqual(['applied', 'applied']);
    });
  });
});
