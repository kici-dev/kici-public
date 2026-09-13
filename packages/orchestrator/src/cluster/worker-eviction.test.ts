import { describe, it, expect, vi } from 'vitest';
import { WS_CLOSE_PLAN_LIMIT } from '@kici-dev/engine';
import type { PeerInfo, PeerRegistry } from './peer-registry.js';
import {
  selectEvictionTargets,
  WorkerEviction,
  WORKER_DRAIN_TIMEOUT_MS,
} from './worker-eviction.js';

const workers = [
  { instanceId: 'w-1', connectedAt: 100 },
  { instanceId: 'w-2', connectedAt: 200 },
  { instanceId: 'w-3', connectedAt: 300 },
] as unknown as PeerInfo[];

const logger = { warn: vi.fn() };

/** A minimal PeerRegistry whose getConnectedWorkerPeers returns the given set. */
function registryWith(set: readonly PeerInfo[]): PeerRegistry {
  return { getConnectedWorkerPeers: () => [...set] } as unknown as PeerRegistry;
}

describe('selectEvictionTargets', () => {
  it('selects newest-first down to the ceiling', () => {
    expect(selectEvictionTargets(workers, 1).map((w) => w.instanceId)).toEqual(['w-3', 'w-2']);
  });

  it('selects nothing when already at the ceiling', () => {
    expect(selectEvictionTargets(workers, 3)).toEqual([]);
  });

  it('selects nothing when under the ceiling', () => {
    expect(selectEvictionTargets(workers, 5)).toEqual([]);
  });

  it('selects every worker at a zero ceiling', () => {
    expect(selectEvictionTargets(workers, 0)).toHaveLength(3);
  });
});

describe('WorkerEviction', () => {
  function build(runningJobs: Record<string, number>) {
    const idleCallbacks = new Map<string, () => void>();
    const hooks = {
      markIneligible: vi.fn(),
      clearIneligible: vi.fn(),
      runningJobCount: (id: string) => runningJobs[id] ?? 0,
      onPeerIdle: (id: string, cb: () => void) => idleCallbacks.set(id, cb),
      closePeer: vi.fn(),
    };
    return { hooks, idleCallbacks };
  }

  it('stops dispatching to a target before disconnecting it', () => {
    const { hooks } = build({ 'w-3': 1 });
    new WorkerEviction(registryWith(workers), hooks, logger).reconcile(2, true);
    expect(hooks.markIneligible).toHaveBeenCalledWith('w-3');
    expect(hooks.closePeer).not.toHaveBeenCalled();
  });

  it('does not drain when evictExcess is false, even over the ceiling', () => {
    const { hooks } = build({});
    new WorkerEviction(registryWith(workers), hooks, logger).reconcile(1, false);
    expect(hooks.markIneligible).not.toHaveBeenCalled();
    expect(hooks.closePeer).not.toHaveBeenCalled();
  });

  it('disconnects immediately when the target has no in-flight jobs', () => {
    const { hooks } = build({});
    new WorkerEviction(registryWith(workers), hooks, logger).reconcile(2, true);
    expect(hooks.closePeer).toHaveBeenCalledWith('w-3', WS_CLOSE_PLAN_LIMIT, expect.any(String));
    // Ineligibility is cleared after disconnect so a re-admission starts clean.
    expect(hooks.clearIneligible).toHaveBeenCalledWith('w-3');
  });

  it('disconnects once the target goes idle', () => {
    const { hooks, idleCallbacks } = build({ 'w-3': 1 });
    new WorkerEviction(registryWith(workers), hooks, logger).reconcile(2, true);
    idleCallbacks.get('w-3')?.();
    expect(hooks.closePeer).toHaveBeenCalledWith('w-3', WS_CLOSE_PLAN_LIMIT, expect.any(String));
  });

  it('disconnects a stuck target after the drain timeout', () => {
    vi.useFakeTimers();
    const { hooks } = build({ 'w-3': 1 });
    new WorkerEviction(registryWith(workers), hooks, logger).reconcile(2, true);
    vi.advanceTimersByTime(WORKER_DRAIN_TIMEOUT_MS + 1);
    expect(hooks.closePeer).toHaveBeenCalledWith('w-3', WS_CLOSE_PLAN_LIMIT, expect.any(String));
    vi.useRealTimers();
  });

  it('does not start a second drain for a target already draining', () => {
    const { hooks } = build({ 'w-3': 1 });
    const eviction = new WorkerEviction(registryWith(workers), hooks, logger);
    eviction.reconcile(2, true);
    eviction.reconcile(2, true);
    expect(hooks.markIneligible).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight drain and restores the worker when the ceiling rises', () => {
    const { hooks } = build({ 'w-3': 1 }); // w-3 draining (has in-flight job), not yet closed
    const eviction = new WorkerEviction(registryWith(workers), hooks, logger);
    eviction.reconcile(2, true);
    expect(hooks.markIneligible).toHaveBeenCalledWith('w-3');
    expect(hooks.closePeer).not.toHaveBeenCalled();

    // Ceiling raised to 3 (org back within limit): w-3 is no longer excess.
    eviction.reconcile(3, true);
    expect(hooks.clearIneligible).toHaveBeenCalledWith('w-3');
    expect(hooks.closePeer).not.toHaveBeenCalled();
  });

  it('cancels an in-flight drain when evictExcess is cleared', () => {
    const { hooks } = build({ 'w-3': 1 });
    const eviction = new WorkerEviction(registryWith(workers), hooks, logger);
    eviction.reconcile(2, true);
    eviction.reconcile(0, false); // org dropped back under → stop evicting
    expect(hooks.clearIneligible).toHaveBeenCalledWith('w-3');
    expect(hooks.closePeer).not.toHaveBeenCalled();
  });

  it('a cancelled drain does not disconnect at the timeout', () => {
    vi.useFakeTimers();
    const { hooks } = build({ 'w-3': 1 });
    const eviction = new WorkerEviction(registryWith(workers), hooks, logger);
    eviction.reconcile(2, true);
    eviction.reconcile(3, true); // rescued
    vi.advanceTimersByTime(WORKER_DRAIN_TIMEOUT_MS + 1);
    expect(hooks.closePeer).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
