import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockWarn = vi.hoisted(() => vi.fn());

// Partial mock: only `createLogger` is replaced, so every other shared export
// the module under test uses is still the real one.
vi.mock('@kici-dev/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kici-dev/shared')>()),
  createLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
}));

import {
  EventProvisionReaper,
  adopterIsLive,
  clusterViewSufficient,
  canReapForCluster,
  reaperFlapGraceMs,
  PROVISION_OUTCOME_RETENTION_MS,
  type EventProvisionReaperOptions,
  type ReaperWindows,
} from './event-provision-reaper.js';
import { PeerRegistry } from '../cluster/peer-registry.js';
import { setScalerReapBlocked, setScalerReapUnseenProvisions } from '../metrics/prometheus.js';

// Partial mock: only the two gauges these tests read are replaced, so every
// other metric the module registers is still defined for real.
vi.mock('../metrics/prometheus.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../metrics/prometheus.js')>()),
  setScalerReapBlocked: vi.fn(),
  setScalerReapUnseenProvisions: vi.fn(),
}));

/** The last value published to a mocked gauge, or undefined if never called. */
function lastGauge(gauge: typeof setScalerReapBlocked | typeof setScalerReapUnseenProvisions) {
  const calls = vi.mocked(gauge).mock.calls;
  return calls.at(-1)?.[0];
}
import { ScaleDownReason } from './scaler-events.js';
import type { ReapCandidate } from './scaler-state-store.js';

const HEARTBEAT_TIMEOUT = ScaleDownReason.enum['heartbeat-timeout'];
const SPAWN_TIMEOUT = ScaleDownReason.enum['spawn-timeout'];

const NOW = new Date('2026-08-21T12:00:00Z').getTime();
const INTERVAL_MS = 60_000;
const SPAWN_TIMEOUT_MS = 300_000;
const FLAP_GRACE_MS = 120_000;
const STRANDED_TIMEOUT_MS = 1_800_000;
const REATTEMPT_INTERVAL_MS = 600_000;
const CLAIM_RETENTION_MS = 3_600_000;

const WINDOWS: ReaperWindows = {
  intervalMs: INTERVAL_MS,
  spawnTimeoutMs: SPAWN_TIMEOUT_MS,
  flapGraceMs: FLAP_GRACE_MS,
  strandedTimeoutMs: STRANDED_TIMEOUT_MS,
  reattemptIntervalMs: REATTEMPT_INTERVAL_MS,
  claimRetentionMs: CLAIM_RETENTION_MS,
};

/** A candidate spawned `ageMs` before the frozen clock. */
function candidate(overrides: Partial<ReapCandidate> & { ageMs: number }): ReapCandidate {
  const { ageMs, ...rest } = overrides;
  return {
    agentId: 'a1',
    scalerName: 's',
    provisioningTargets: ['t'],
    spawnedAt: new Date(NOW - ageMs),
    ...rest,
  };
}

function makeReaper(opts: Partial<EventProvisionReaperOptions> = {}) {
  // Return the handles actually wired in: returning local stubs when an
  // override wins would make assertions vacuously observe an unused spy.
  const emitScaleDown = opts.emitScaleDown ?? vi.fn().mockResolvedValue(undefined);
  const purgeExpiredClaims = opts.purgeExpiredClaims ?? vi.fn().mockResolvedValue(0);
  const purgeProvisionOutcomes = opts.purgeProvisionOutcomes ?? vi.fn().mockResolvedValue(0);
  const listCandidates = opts.listCandidates ?? vi.fn().mockResolvedValue([]);
  const resolveWindows = opts.resolveWindows ?? vi.fn().mockResolvedValue(WINDOWS);
  const reaper = new EventProvisionReaper({
    isPeerLive: () => true,
    isAgentRegistered: () => false,
    canReap: () => true,
    bootIntervalMs: INTERVAL_MS,
    ...opts,
    listCandidates,
    emitScaleDown,
    purgeExpiredClaims,
    purgeProvisionOutcomes,
    resolveWindows,
  });
  return {
    reaper,
    emitScaleDown,
    purgeExpiredClaims,
    purgeProvisionOutcomes,
    listCandidates,
    resolveWindows,
  };
}

/** A reaper whose candidate list is fixed, already leading. */
function leadingReaper(rows: ReapCandidate[], opts: Partial<EventProvisionReaperOptions> = {}) {
  const made = makeReaper({ listCandidates: vi.fn().mockResolvedValue(rows), ...opts });
  made.reaper.onBecomeLeader();
  return made;
}

/** Sweep, advance by `ms`, sweep again: no arm fires on a single observation. */
async function sustain(reaper: EventProvisionReaper, ms: number = FLAP_GRACE_MS): Promise<void> {
  await reaper.tick();
  vi.setSystemTime(Date.now() + ms);
  await reaper.tick();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(setScalerReapBlocked).mockClear();
  vi.mocked(setScalerReapUnseenProvisions).mockClear();
  mockWarn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('adopterIsLive', () => {
  it('treats a connected peer as live', () => {
    expect(adopterIsLive({ connected: true, lastHeartbeatAt: 0 }, NOW, FLAP_GRACE_MS)).toBe(true);
  });

  // A link blip between two healthy coordinators must not read as a dead one.
  it('treats a just-disconnected peer as live for the flap grace', () => {
    const peer = { connected: false, lastHeartbeatAt: NOW - FLAP_GRACE_MS };
    expect(adopterIsLive(peer, NOW, FLAP_GRACE_MS)).toBe(true);
  });

  it('treats a peer silent past the flap grace as gone', () => {
    const peer = { connected: false, lastHeartbeatAt: NOW - FLAP_GRACE_MS - 1 };
    expect(adopterIsLive(peer, NOW, FLAP_GRACE_MS)).toBe(false);
  });

  it('treats an unknown peer as gone', () => {
    expect(adopterIsLive(undefined, NOW, FLAP_GRACE_MS)).toBe(false);
  });
});

describe('clusterViewSufficient', () => {
  it('lets a coordinator that has never met a peer sweep', () => {
    expect(clusterViewSufficient(0, 0)).toBe(true);
  });

  // The count is of *known* peers, not configured ones: a Platform-mode HA pair
  // joins by token and never sets KICI_CLUSTER_PEERS, so keying on config lets
  // both halves of a partition tear down each other's live instances.
  it('blocks a coordinator that knows peers but is connected to none', () => {
    expect(clusterViewSufficient(1, 0)).toBe(false);
  });

  it('lets a coordinator that still sees a peer sweep', () => {
    expect(clusterViewSufficient(2, 1)).toBe(true);
  });
});

// Driven through a REAL `PeerRegistry`: `getCoordinatorPeers()` filters on role,
// not connectivity, which a stub would hide while `clusterViewSufficient` alone
// stays green.
describe('canReapForCluster', () => {
  function registryWith(
    peers: Array<{ instanceId: string; role: 'coordinator' | 'worker'; connected: boolean }>,
  ): PeerRegistry {
    const registry = new PeerRegistry();
    for (const peer of peers) {
      registry.addPeer({
        instanceId: peer.instanceId,
        connectionId: `conn-${peer.instanceId}`,
        address: null,
        routingKeys: [],
        role: peer.role,
      });
      if (!peer.connected) registry.markDisconnected(peer.instanceId);
    }
    return registry;
  }

  // The Platform-mode HA-pair partition: no static config, one handshaken peer,
  // now unreachable. Keying on `config.cluster.peers.length` alone returns true
  // here and tears down the other side's live instances.
  it('blocks when a handshaken coordinator peer is disconnected and config names none', () => {
    const registry = registryWith([
      { instanceId: 'orch-b', role: 'coordinator', connected: false },
    ]);
    expect(canReapForCluster(0, registry)).toBe(false);
  });

  it('sweeps when that peer is connected', () => {
    const registry = registryWith([{ instanceId: 'orch-b', role: 'coordinator', connected: true }]);
    expect(canReapForCluster(0, registry)).toBe(true);
  });

  // A guard that blocks forever would disable the backstop on every single coordinator.
  it('sweeps on a coordinator that knows no peers at all', () => {
    expect(canReapForCluster(0, registryWith([]))).toBe(true);
  });

  // Workers do not vote in raft and cannot adopt provisions, so they must not
  // arm the guard; counting them would block every worker-only deployment.
  it('ignores worker peers entirely', () => {
    const registry = registryWith([{ instanceId: 'agent-host', role: 'worker', connected: false }]);
    expect(canReapForCluster(0, registry)).toBe(true);
  });

  // Independent mode: the registry is empty because no handshake succeeded, and
  // the static array is the only evidence a peer is expected.
  it('blocks on a configured peer the registry has never seen', () => {
    expect(canReapForCluster(1, registryWith([]))).toBe(false);
  });

  // The backstop keeps running on a partial loss.
  it('sweeps on a 3-node cluster with one peer down', () => {
    const registry = registryWith([
      { instanceId: 'orch-b', role: 'coordinator', connected: true },
      { instanceId: 'orch-c', role: 'coordinator', connected: false },
    ]);
    expect(canReapForCluster(0, registry)).toBe(true);
  });
});

describe('reaperFlapGraceMs', () => {
  // The knob is shared with the rerouted-job guard (worst case: a force-failed
  // run); here the worst case is a deleted instance, so lowering it for reroute
  // reasons must not collapse this arm.
  it('floors a lowered knob at two peer-stale windows', () => {
    expect(reaperFlapGraceMs(5000, 60_000)).toBe(120_000);
  });

  it('honours a knob raised above the floor', () => {
    expect(reaperFlapGraceMs(300_000, 60_000)).toBe(300_000);
  });

  // Slower heartbeats get a proportionally wider guard.
  it('tracks the configured stale timeout', () => {
    expect(reaperFlapGraceMs(5000, 90_000)).toBe(180_000);
  });
});

describe('EventProvisionReaper', () => {
  describe('leadership gating', () => {
    it('does nothing at all when it is not the leader', async () => {
      const { reaper, emitScaleDown, listCandidates, purgeExpiredClaims } = makeReaper({
        listCandidates: vi
          .fn()
          .mockResolvedValue([candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'a' })]),
      });

      await reaper.tick();

      expect(listCandidates).not.toHaveBeenCalled();
      expect(purgeExpiredClaims).not.toHaveBeenCalled();
      expect(emitScaleDown).not.toHaveBeenCalled();
    });

    it('sweeps on the timer while leading and stops on losing leadership', async () => {
      const { reaper, listCandidates } = leadingReaper([]);

      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(listCandidates).toHaveBeenCalledTimes(1);

      reaper.onLoseLeadership();
      await vi.advanceTimersByTimeAsync(10 * INTERVAL_MS);
      expect(listCandidates).toHaveBeenCalledTimes(1);
    });

    it('stops the timer on stop()', async () => {
      const { reaper, listCandidates } = leadingReaper([]);
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(listCandidates).toHaveBeenCalledTimes(1);

      reaper.stop();
      await vi.advanceTimersByTimeAsync(10 * INTERVAL_MS);
      expect(listCandidates).toHaveBeenCalledTimes(1);
    });

    it('passes the spawn cutoff derived from the current clock', async () => {
      const { reaper, listCandidates } = leadingReaper([]);
      await reaper.tick();
      expect(listCandidates).toHaveBeenCalledWith(new Date(NOW - SPAWN_TIMEOUT_MS));
    });

    // Leadership can move across an await and `lastAttemptAt` is per-instance,
    // so a former leader that keeps emitting races the new one undeduped.
    it('stops mid-sweep when leadership is lost while tearing a row down', async () => {
      const stranded = (agentId: string) =>
        candidate({ agentId, ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' });
      const rows = [stranded('a1'), stranded('a2'), stranded('a3')];

      // Control: leadership held throughout, so all three go out.
      const control = leadingReaper(rows);
      await sustain(control.reaper);
      expect(control.emitScaleDown.mock.calls.map((c) => c[0].agentId)).toEqual(['a1', 'a2', 'a3']);

      // Subject: identical, except the first teardown loses leadership.
      const subject = makeReaper({
        listCandidates: vi.fn().mockResolvedValue(rows),
        emitScaleDown: vi.fn().mockImplementation(async () => {
          subject.reaper.onLoseLeadership();
        }),
      });
      subject.reaper.onBecomeLeader();
      vi.setSystemTime(NOW);
      await sustain(subject.reaper);

      expect(subject.emitScaleDown.mock.calls.map((c) => c[0].agentId)).toEqual(['a1']);
    });

    // A former leader stops acting on the rest of the sweep and leaves no
    // reading standing on the scrape endpoint. Without the per-candidate guard
    // the loop tears down a2 and a3 after losing the right to.
    it('condemns no further rows after leadership is lost mid-loop', async () => {
      const stranded = (agentId: string) =>
        candidate({ agentId, ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' });
      const made = makeReaper({
        listCandidates: vi.fn().mockResolvedValue([stranded('a1'), stranded('a2'), stranded('a3')]),
        emitScaleDown: vi.fn().mockImplementation(async () => {
          made.reaper.onLoseLeadership();
        }),
      });
      made.reaper.onBecomeLeader();

      await made.reaper.tick();
      // No clock is past the flap grace yet, so the gauge is honestly zero.
      expect(made.emitScaleDown).not.toHaveBeenCalled();
      expect(lastGauge(setScalerReapUnseenProvisions)).toBe(0);

      vi.setSystemTime(NOW + FLAP_GRACE_MS);
      await made.reaper.tick();

      expect(made.emitScaleDown.mock.calls.map((c) => c[0].agentId)).toEqual(['a1']);
      expect(lastGauge(setScalerReapUnseenProvisions)).toBe(0);
    });

    it('purges provision outcomes on the same sweep that purges claims', async () => {
      const { reaper, purgeProvisionOutcomes, purgeExpiredClaims } = leadingReaper([]);

      await reaper.tick();

      expect(purgeProvisionOutcomes).toHaveBeenCalledTimes(1);
      expect(purgeExpiredClaims).toHaveBeenCalledTimes(1);
      // The default spawn deadline is far below the floor, so this arm pins the
      // floor itself; the test below covers the deadline-derived widening.
      expect(purgeProvisionOutcomes).toHaveBeenLastCalledWith(
        new Date(NOW - PROVISION_OUTCOME_RETENTION_MS),
      );
    });

    it('widens the outcome retention when the spawn deadline passes half of it', async () => {
      // The other arm: a spawn deadline whose double exceeds the 24h floor
      // moves the cutoff with it.
      const spawnTimeoutMs = PROVISION_OUTCOME_RETENTION_MS;
      const resolveWindows = vi.fn().mockResolvedValue({ ...WINDOWS, spawnTimeoutMs });
      const { reaper, purgeProvisionOutcomes } = leadingReaper([], { resolveWindows });

      await reaper.tick();

      expect(purgeProvisionOutcomes).toHaveBeenLastCalledWith(new Date(NOW - 2 * spawnTimeoutMs));
    });

    it('does not purge outcomes on a non-leader', async () => {
      const { reaper, purgeProvisionOutcomes } = makeReaper();

      await reaper.tick();

      expect(purgeProvisionOutcomes).not.toHaveBeenCalled();
    });

    it('keeps sweeping when the outcome purge throws', async () => {
      // A purge failure must not strand the interval reconcile that follows it,
      // or one bad sweep freezes the cadence.
      const purgeProvisionOutcomes = vi.fn().mockRejectedValue(new Error('db down'));
      const { reaper } = leadingReaper([], { purgeProvisionOutcomes });

      await expect(reaper.tick()).resolves.toBeUndefined();
      expect(purgeProvisionOutcomes).toHaveBeenCalledTimes(1);
    });

    it('skips the claim purge when leadership is lost during the reap half', async () => {
      const { reaper, purgeExpiredClaims, emitScaleDown } = makeReaper({
        listCandidates: vi
          .fn()
          .mockResolvedValue([
            candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' }),
          ]),
      });
      emitScaleDown.mockImplementation(async () => {
        reaper.onLoseLeadership();
      });
      reaper.onBecomeLeader();
      await sustain(reaper);

      // Two sweeps ran; the first purged (no teardown yet), the second stopped
      // after the teardown dropped leadership.
      expect(emitScaleDown).toHaveBeenCalledTimes(1);
      expect(purgeExpiredClaims).toHaveBeenCalledTimes(1);
    });
  });

  // Every window is re-resolved on each sweep and applied to that same sweep.
  // All but the spawn deadline (static config) are live cluster_settings knobs;
  // a knob the sweep ignores until the next election is worse than none, so
  // each is pinned to a behaviour that changes when it changes.
  describe('live sweep windows', () => {
    it('re-reads its windows on every sweep', async () => {
      const { reaper, resolveWindows } = leadingReaper([]);

      await reaper.tick();
      await reaper.tick();

      expect(resolveWindows).toHaveBeenCalledTimes(2);
    });

    it('applies a changed spawn timeout to the very next sweep', async () => {
      const resolveWindows = vi
        .fn()
        .mockResolvedValueOnce(WINDOWS)
        .mockResolvedValue({ ...WINDOWS, spawnTimeoutMs: 30_000 });
      const { reaper, listCandidates } = leadingReaper([], { resolveWindows });

      await reaper.tick();
      expect(listCandidates).toHaveBeenLastCalledWith(new Date(NOW - SPAWN_TIMEOUT_MS));

      await reaper.tick();
      expect(listCandidates).toHaveBeenLastCalledWith(new Date(NOW - 30_000));
    });

    it('applies a changed claim retention to the very next sweep', async () => {
      const resolveWindows = vi
        .fn()
        .mockResolvedValueOnce(WINDOWS)
        .mockResolvedValue({ ...WINDOWS, claimRetentionMs: 1000 });
      const { reaper, purgeExpiredClaims } = leadingReaper([], { resolveWindows });

      await reaper.tick();
      expect(purgeExpiredClaims).toHaveBeenLastCalledWith(new Date(NOW - CLAIM_RETENTION_MS));

      await reaper.tick();
      expect(purgeExpiredClaims).toHaveBeenLastCalledWith(new Date(NOW - 1000));
    });

    it('applies a changed stranded timeout to the very next sweep', async () => {
      const row = candidate({ ageMs: 1000, adoptedBy: 'orch-b' });
      const shortStranded = 3 * FLAP_GRACE_MS;
      // Control keeps the 30-minute window; subject shrinks it. Both observe
      // the agent unseen for exactly the shortened window.
      const control = leadingReaper([row]);
      const subject = leadingReaper([row], {
        resolveWindows: vi.fn().mockResolvedValue({ ...WINDOWS, strandedTimeoutMs: shortStranded }),
      });

      await control.reaper.tick();
      await subject.reaper.tick();
      vi.setSystemTime(NOW + shortStranded);
      await control.reaper.tick();
      await subject.reaper.tick();

      expect(control.emitScaleDown).not.toHaveBeenCalled();
      expect(subject.emitScaleDown).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_TIMEOUT);
    });

    it('applies a changed flap grace to the very next sweep', async () => {
      const row = candidate({ ageMs: 1000, adoptedBy: 'orch-b' });
      const dead = { isPeerLive: () => false };
      // The dead-adopter arm fires once the absence outlasts the flap grace.
      const control = leadingReaper([row], dead);
      const subject = leadingReaper([row], {
        ...dead,
        resolveWindows: vi.fn().mockResolvedValue({ ...WINDOWS, flapGraceMs: 1000 }),
      });

      await control.reaper.tick();
      await subject.reaper.tick();
      vi.setSystemTime(NOW + 1000);
      await control.reaper.tick();
      await subject.reaper.tick();

      expect(control.emitScaleDown).not.toHaveBeenCalled();
      expect(subject.emitScaleDown).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_TIMEOUT);
    });

    it('hands the live flap grace to the adopter-liveness check', async () => {
      const isPeerLive = vi.fn().mockReturnValue(true);
      const { reaper } = leadingReaper([candidate({ ageMs: 1000, adoptedBy: 'orch-b' })], {
        isPeerLive,
        resolveWindows: vi.fn().mockResolvedValue({ ...WINDOWS, flapGraceMs: 1000 }),
      });

      await sustain(reaper, 1000);

      expect(isPeerLive).toHaveBeenLastCalledWith('orch-b', 1000);
    });

    it('applies a changed re-attempt interval to the very next sweep', async () => {
      const stranded = () => candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' });
      const control = leadingReaper([stranded()]);
      const subject = leadingReaper([stranded()], {
        resolveWindows: vi.fn().mockResolvedValue({ ...WINDOWS, reattemptIntervalMs: 1000 }),
      });

      // Both reach their first teardown at the same instant.
      await sustain(control.reaper);
      vi.setSystemTime(NOW);
      await sustain(subject.reaper);
      expect(control.emitScaleDown).toHaveBeenCalledTimes(1);
      expect(subject.emitScaleDown).toHaveBeenCalledTimes(1);

      // 2s later the default 10-minute window still throttles; the 1s one does not.
      vi.setSystemTime(Date.now() + 2000);
      await control.reaper.tick();
      await subject.reaper.tick();

      expect(control.emitScaleDown).toHaveBeenCalledTimes(1);
      expect(subject.emitScaleDown).toHaveBeenCalledTimes(2);
    });

    it('reschedules its timer when the interval knob changes', async () => {
      const resolveWindows = vi.fn().mockResolvedValue({ ...WINDOWS, intervalMs: 5000 });
      const { reaper, listCandidates } = leadingReaper([], { resolveWindows });

      // Boot interval: onBecomeLeader is a synchronous Raft callback, so
      // nothing has been read from the database yet.
      expect(reaper.currentIntervalMs()).toBe(INTERVAL_MS);

      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(listCandidates).toHaveBeenCalledTimes(1);
      expect(reaper.currentIntervalMs()).toBe(5000);

      // At the boot cadence exactly one more sweep would have run in this
      // window; at the adopted one, twelve.
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(listCandidates).toHaveBeenCalledTimes(1 + INTERVAL_MS / 5000);
    });

    it('keeps the current timer when the interval knob is unchanged', async () => {
      const { reaper, listCandidates } = leadingReaper([]);

      await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);

      expect(reaper.currentIntervalMs()).toBe(INTERVAL_MS);
      expect(listCandidates).toHaveBeenCalledTimes(3);
    });

    it('ignores an unusable interval rather than spinning the sweep', async () => {
      const resolveWindows = vi.fn().mockResolvedValue({ ...WINDOWS, intervalMs: 0 });
      const { reaper, listCandidates } = leadingReaper([], { resolveWindows });

      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(reaper.currentIntervalMs()).toBe(INTERVAL_MS);
      // A 0 ms interval adopted would have fired thousands of times here.
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(listCandidates).toHaveBeenCalledTimes(2);
    });

    it('skips the sweep, without throwing, when the windows cannot be read', async () => {
      const { reaper, listCandidates, purgeExpiredClaims } = leadingReaper([], {
        resolveWindows: vi.fn().mockRejectedValue(new Error('settings unreadable')),
      });

      await expect(reaper.tick()).resolves.toBeUndefined();

      expect(listCandidates).not.toHaveBeenCalled();
      expect(purgeExpiredClaims).not.toHaveBeenCalled();
    });

    it('does not read its windows while it is not the leader', async () => {
      const { reaper, resolveWindows } = makeReaper();
      await reaper.tick();
      expect(resolveWindows).not.toHaveBeenCalled();
    });
  });

  // "Registered nowhere" holds for live agents on routine events (a local WS
  // reconnect, a reconnected peer briefly advertising no agents), so the reaper
  // times how long the observation has held, never how old the row is.
  describe('sustained-absence debounce', () => {
    it('spares an unadopted provision on the first sample and reaps it once sustained', async () => {
      const { reaper, emitScaleDown } = leadingReaper([
        candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' }),
      ]);

      await reaper.tick();
      expect(emitScaleDown).not.toHaveBeenCalled();

      vi.setSystemTime(NOW + FLAP_GRACE_MS);
      await reaper.tick();
      expect(emitScaleDown).toHaveBeenCalledWith(expect.anything(), SPAWN_TIMEOUT);
    });

    it('spares a dead-adopter provision on the first sample and reaps it once sustained', async () => {
      const { reaper, emitScaleDown } = leadingReaper(
        [candidate({ ageMs: 1000, adoptedBy: 'orch-b' })],
        { isPeerLive: () => false },
      );

      await reaper.tick();
      expect(emitScaleDown).not.toHaveBeenCalled();

      vi.setSystemTime(NOW + FLAP_GRACE_MS);
      await reaper.tick();
      expect(emitScaleDown).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_TIMEOUT);
    });

    // This pair pins the stranded window: reaping an ancient adopted row with a
    // live adopter on its first unregistered sample tears down live VMs on
    // every peer reconnect.
    it('spares a long-running adopted provision seen unregistered once, however old the row', async () => {
      const { reaper, emitScaleDown } = leadingReaper(
        [candidate({ ageMs: 100 * STRANDED_TIMEOUT_MS, adoptedBy: 'orch-b' })],
        { isPeerLive: () => true, isAgentRegistered: () => false },
      );

      await reaper.tick();
      // Well past the flap grace, and still inside the stranded window.
      vi.setSystemTime(NOW + STRANDED_TIMEOUT_MS - 1);
      await reaper.tick();

      expect(emitScaleDown).not.toHaveBeenCalled();
    });

    it('reaps a long-running adopted provision once unregistered across the whole window', async () => {
      const { reaper, emitScaleDown } = leadingReaper(
        [candidate({ ageMs: 100 * STRANDED_TIMEOUT_MS, adoptedBy: 'orch-b' })],
        { isPeerLive: () => true, isAgentRegistered: () => false },
      );

      await reaper.tick();
      vi.setSystemTime(NOW + STRANDED_TIMEOUT_MS);
      await reaper.tick();

      expect(emitScaleDown).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_TIMEOUT);
    });

    // Otherwise a flapping-but-live agent accumulates absence across unrelated
    // blips until it crosses the window.
    it('restarts the clock when the agent is seen registered again', async () => {
      let registered = false;
      const { reaper, emitScaleDown } = leadingReaper(
        [candidate({ ageMs: 100 * STRANDED_TIMEOUT_MS, adoptedBy: 'orch-b' })],
        { isPeerLive: () => true, isAgentRegistered: () => registered },
      );

      await reaper.tick(); // unseen — clock starts
      vi.setSystemTime(NOW + STRANDED_TIMEOUT_MS - 1);
      registered = true;
      await reaper.tick(); // seen — clock cleared
      registered = false;
      await reaper.tick(); // unseen — clock restarts from here
      vi.setSystemTime(Date.now() + STRANDED_TIMEOUT_MS - 1);
      await reaper.tick();

      expect(emitScaleDown).not.toHaveBeenCalled();

      // And the restarted clock does still expire.
      vi.setSystemTime(Date.now() + 1);
      await reaper.tick();
      expect(emitScaleDown).toHaveBeenCalledWith(expect.anything(), HEARTBEAT_TIMEOUT);
    });

    it('forgets the clock when leadership is lost', async () => {
      const { reaper, emitScaleDown } = leadingReaper([
        candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' }),
      ]);

      await reaper.tick();
      reaper.onLoseLeadership();
      reaper.onBecomeLeader();
      vi.setSystemTime(NOW + FLAP_GRACE_MS);
      await reaper.tick();

      // The new leadership has one observation, not two, so nothing is reaped.
      expect(emitScaleDown).not.toHaveBeenCalled();
    });

    it('forgets the clock for a row that dropped out of the candidate set', async () => {
      const row = candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' });
      const listCandidates = vi
        .fn()
        .mockResolvedValueOnce([row])
        .mockResolvedValueOnce([])
        .mockResolvedValue([row]);
      const { reaper, emitScaleDown } = makeReaper({ listCandidates });
      reaper.onBecomeLeader();

      await reaper.tick();
      vi.setSystemTime(NOW + FLAP_GRACE_MS);
      await reaper.tick(); // row absent — its clock is pruned
      await reaper.tick(); // row back — first observation again

      expect(emitScaleDown).not.toHaveBeenCalled();
    });
  });

  describe('partition guard', () => {
    it('does not reap while this coordinator sees none of its peers', async () => {
      const { reaper, emitScaleDown, listCandidates } = leadingReaper(
        [candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' })],
        { canReap: () => false },
      );

      await sustain(reaper);

      expect(listCandidates).not.toHaveBeenCalled();
      expect(emitScaleDown).not.toHaveBeenCalled();
    });

    it('still purges expired claims while blocked', async () => {
      const { reaper, purgeExpiredClaims } = leadingReaper([], { canReap: () => false });

      await reaper.tick();

      expect(purgeExpiredClaims).toHaveBeenCalledWith(new Date(NOW - CLAIM_RETENTION_MS));
    });

    it('reaps again once the cluster view returns', async () => {
      let visible = false;
      const { reaper, emitScaleDown } = leadingReaper(
        [candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' })],
        { canReap: () => visible },
      );

      await sustain(reaper);
      expect(emitScaleDown).not.toHaveBeenCalled();

      visible = true;
      await sustain(reaper);
      expect(emitScaleDown).toHaveBeenCalledWith(expect.anything(), SPAWN_TIMEOUT);
    });

    // Absence observed without a cluster view is not evidence, so a heal must
    // re-observe it rather than inherit a clock measured while blind.
    it('discards absence observed while blocked', async () => {
      let visible = true;
      const { reaper, emitScaleDown } = leadingReaper(
        [candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' })],
        { canReap: () => visible },
      );

      await reaper.tick(); // clock starts
      visible = false;
      await reaper.tick(); // blocked — clock discarded
      visible = true;
      vi.setSystemTime(NOW + FLAP_GRACE_MS);
      await reaper.tick(); // first observation of the healed view

      expect(emitScaleDown).not.toHaveBeenCalled();
    });
  });

  describe('unadopted provisions', () => {
    it('tears down a provision that was never adopted past the deadline', async () => {
      const { reaper, emitScaleDown } = leadingReaper([
        candidate({ ageMs: SPAWN_TIMEOUT_MS + 1, ownerInstanceId: 'orch-a' }),
      ]);

      await sustain(reaper);

      expect(emitScaleDown).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'a1' }),
        SPAWN_TIMEOUT,
      );
    });

    // Negative control for the test above: same row, one field flipped.
    it('leaves an unadopted provision alone before the deadline', async () => {
      const { reaper, emitScaleDown } = leadingReaper([
        candidate({ ageMs: SPAWN_TIMEOUT_MS - FLAP_GRACE_MS - 1, ownerInstanceId: 'orch-a' }),
      ]);

      await sustain(reaper);

      expect(emitScaleDown).not.toHaveBeenCalled();
    });

    // A pre-migration-119 row has an unknown owner, never "not mine".
    it('leaves an unadopted, unowned row alone however old it is', async () => {
      const { reaper, emitScaleDown } = leadingReaper([
        candidate({ ageMs: 100 * SPAWN_TIMEOUT_MS }),
      ]);

      await sustain(reaper);

      expect(emitScaleDown).not.toHaveBeenCalled();
    });

    it('leaves an unadopted provision alone while its agent is registered', async () => {
      const { reaper, emitScaleDown } = leadingReaper(
        [candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' })],
        { isAgentRegistered: () => true },
      );

      await sustain(reaper);

      expect(emitScaleDown).not.toHaveBeenCalled();
    });
  });

  describe('adopted provisions', () => {
    it('tears down a provision whose adopter died with no registered agent', async () => {
      const { reaper, emitScaleDown } = leadingReaper(
        [candidate({ ageMs: 1000, adoptedBy: 'orch-b' })],
        { isPeerLive: () => false, isAgentRegistered: () => false },
      );

      await sustain(reaper);

      expect(emitScaleDown).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'a1' }),
        HEARTBEAT_TIMEOUT,
      );
    });

    it('asks about the adopter, not about some other instance', async () => {
      const isPeerLive = vi.fn().mockReturnValue(true);
      const { reaper } = leadingReaper([candidate({ ageMs: 1000, adoptedBy: 'orch-b' })], {
        isPeerLive,
      });

      await sustain(reaper);

      expect(isPeerLive).toHaveBeenCalledWith('orch-b', FLAP_GRACE_MS);
    });

    it('leaves a healthy adopted provision alone however long it has run', async () => {
      const { reaper, emitScaleDown } = leadingReaper(
        [candidate({ ageMs: 100 * STRANDED_TIMEOUT_MS, adoptedBy: 'orch-b' })],
        { isPeerLive: () => true, isAgentRegistered: () => true },
      );

      await sustain(reaper, 100 * STRANDED_TIMEOUT_MS);

      expect(emitScaleDown).not.toHaveBeenCalled();
    });

    it('leaves an adopted provision alone while its agent is still registered', async () => {
      const { reaper, emitScaleDown } = leadingReaper(
        [candidate({ ageMs: 100 * STRANDED_TIMEOUT_MS, adoptedBy: 'orch-b' })],
        { isPeerLive: () => false, isAgentRegistered: () => true },
      );

      await sustain(reaper, 100 * STRANDED_TIMEOUT_MS);

      expect(emitScaleDown).not.toHaveBeenCalled();
    });

    // Ageing is on observed absence and, for the spawn arm, on `spawnedAt` —
    // never on `adopted_at`, which a self-re-adopt refreshes. `ReapCandidate`
    // deliberately carries no `adoptedAt`, making that mistake unrepresentable.
  });

  describe('re-attempt throttle', () => {
    // `emitScaleDownForSpec` keeps the row (and logs at error) when neither the
    // row nor local config names a provisioning target, so the same candidate
    // comes back every tick. Without a throttle that is an unbounded log loop.
    it('does not re-emit a candidate that survived its teardown on the next tick', async () => {
      const { reaper, emitScaleDown } = leadingReaper([
        candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' }),
      ]);

      await sustain(reaper);
      expect(emitScaleDown).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + REATTEMPT_INTERVAL_MS - 1);
      await reaper.tick();
      expect(emitScaleDown).toHaveBeenCalledTimes(1);
    });

    it('re-emits once the re-attempt window has elapsed', async () => {
      const { reaper, emitScaleDown } = leadingReaper([
        candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' }),
      ]);

      await sustain(reaper);
      vi.setSystemTime(Date.now() + REATTEMPT_INTERVAL_MS);
      await reaper.tick();

      expect(emitScaleDown).toHaveBeenCalledTimes(2);
    });

    it('throttles per agent, so a second stranded row is not held back', async () => {
      const first = candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' });
      const second = candidate({
        agentId: 'a2',
        ageMs: 10 * SPAWN_TIMEOUT_MS,
        ownerInstanceId: 'orch-a',
      });
      const listCandidates = vi
        .fn()
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([first])
        .mockResolvedValue([first, second]);
      const { reaper, emitScaleDown } = makeReaper({ listCandidates });
      reaper.onBecomeLeader();

      await sustain(reaper); // a1 torn down
      vi.setSystemTime(Date.now() + 1000);
      await reaper.tick(); // a2's first observation
      vi.setSystemTime(Date.now() + FLAP_GRACE_MS);
      await reaper.tick(); // a2 torn down; a1 still throttled

      expect(emitScaleDown.mock.calls.map((c) => c[0].agentId)).toEqual(['a1', 'a2']);
    });

    // Guards the `lastAttemptAt` half of `pruneTracking` (`strandedSince` has its
    // own test): the re-emit lands inside the re-attempt window, so a surviving
    // entry throttles it and a pruned one emits.
    it('forgets attempt history for a row that dropped out of the candidate set', async () => {
      const row = candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' });
      const listCandidates = vi
        .fn()
        .mockResolvedValueOnce([row])
        .mockResolvedValueOnce([row])
        .mockResolvedValueOnce([])
        .mockResolvedValue([row]);
      const { reaper, emitScaleDown } = makeReaper({ listCandidates });
      reaper.onBecomeLeader();

      await sustain(reaper); // torn down at NOW + FLAP_GRACE_MS
      expect(emitScaleDown).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 1000);
      await reaper.tick(); // row absent — both maps pruned
      vi.setSystemTime(Date.now() + 1000);
      await reaper.tick(); // row back — absence re-observed
      vi.setSystemTime(Date.now() + FLAP_GRACE_MS);
      await reaper.tick();

      // Only ~122s have passed since the first teardown, well inside the
      // 10-minute re-attempt window, so a surviving entry would throttle this.
      expect(emitScaleDown).toHaveBeenCalledTimes(2);
    });

    it('forgets attempt history when leadership is lost', async () => {
      const { reaper, emitScaleDown } = leadingReaper([
        candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' }),
      ]);

      await sustain(reaper);
      reaper.onLoseLeadership();
      reaper.onBecomeLeader();
      await sustain(reaper);

      expect(emitScaleDown).toHaveBeenCalledTimes(2);
    });
  });

  describe('observability', () => {
    it('publishes how many provisions are past the flap grace, not how many are absent', async () => {
      // `verdict()` refuses to act below the flap grace, and every peer flap
      // briefly marks all its agents absent; counting current absences would
      // keep a healthy cluster permanently above zero on this alert.
      const stranded = (agentId: string) =>
        candidate({ agentId, ageMs: 1000, adoptedBy: 'orch-b' });
      const { reaper } = leadingReaper([stranded('a1'), stranded('a2')]);

      await reaper.tick();
      // Both clocks are running, neither has reached the grace.
      expect(lastGauge(setScalerReapUnseenProvisions)).toBe(0);

      vi.setSystemTime(NOW + FLAP_GRACE_MS);
      await reaper.tick();

      expect(setScalerReapUnseenProvisions).toHaveBeenLastCalledWith(2);
      expect(setScalerReapBlocked).toHaveBeenLastCalledWith(false);
    });

    it('counts only the provisions that are individually past the grace', async () => {
      const rows: ReapCandidate[] = [
        candidate({ agentId: 'early', ageMs: 1000, adoptedBy: 'orch-b' }),
      ];
      const { reaper } = leadingReaper(rows);

      await reaper.tick();
      // `late` only becomes a candidate a full grace later, so its own clock
      // starts then and it must not be counted alongside `early`.
      vi.setSystemTime(NOW + FLAP_GRACE_MS);
      rows.push(candidate({ agentId: 'late', ageMs: 1000, adoptedBy: 'orch-b' }));
      await reaper.tick();

      expect(lastGauge(setScalerReapUnseenProvisions)).toBe(1);

      vi.setSystemTime(NOW + 2 * FLAP_GRACE_MS);
      await reaper.tick();
      expect(lastGauge(setScalerReapUnseenProvisions)).toBe(2);
    });

    it('publishes zero once the agents are seen again', async () => {
      let registered = false;
      const { reaper } = leadingReaper([candidate({ ageMs: 1000, adoptedBy: 'orch-b' })], {
        isAgentRegistered: () => registered,
      });

      await sustain(reaper);
      expect(lastGauge(setScalerReapUnseenProvisions)).toBe(1);

      registered = true;
      await reaper.tick();
      expect(lastGauge(setScalerReapUnseenProvisions)).toBe(0);
    });

    it('warns once for a row whose owner is unknown, instead of sparing it silently', async () => {
      // No other arm reports an unregistered row, so a pre-migration row would
      // otherwise be spared on every sweep forever in silence.
      const rows = [candidate({ agentId: 'legacy-1', ageMs: 10 * SPAWN_TIMEOUT_MS })];
      const { reaper, emitScaleDown } = leadingReaper(rows);

      await sustain(reaper);
      await reaper.tick();

      expect(emitScaleDown).not.toHaveBeenCalled();
      const unknownOwnerWarnings = mockWarn.mock.calls.filter(([message]) =>
        String(message).includes('owner is unknown'),
      );
      // Once per row, not once per sweep — three sweeps ran.
      expect(unknownOwnerWarnings).toHaveLength(1);
      expect(unknownOwnerWarnings[0]?.[1]).toMatchObject({ agentId: 'legacy-1' });
    });

    it('publishes the blocked flag while the reaper is standing down', async () => {
      const { reaper } = leadingReaper([candidate({ ageMs: 1000, adoptedBy: 'orch-b' })], {
        canReap: () => false,
      });

      await reaper.tick();

      expect(lastGauge(setScalerReapBlocked)).toBe(true);
      // Nothing is being timed while blocked, so the count must not stand.
      expect(lastGauge(setScalerReapUnseenProvisions)).toBe(0);
    });

    // A partition blocks the sweep, then heals into a database fault.
    // `resolveWindows` runs before the blocked check, so without a republish on
    // that error path the gauge stays at 1 and pages for a partition that is over.
    it('clears the blocked gauge when a blocked sweep is followed by an unreadable settings read', async () => {
      let visible = false;
      const resolveWindows = vi
        .fn()
        .mockResolvedValueOnce({ ...WINDOWS })
        .mockRejectedValue(new Error('settings unreadable'));
      const { reaper } = leadingReaper([candidate({ ageMs: 1000, adoptedBy: 'orch-b' })], {
        resolveWindows,
        canReap: () => visible,
      });

      await reaper.tick();
      expect(lastGauge(setScalerReapBlocked)).toBe(true);

      visible = true;
      await reaper.tick();

      expect(lastGauge(setScalerReapBlocked)).toBe(false);
    });

    it('still publishes when listing candidates throws', async () => {
      const { reaper } = leadingReaper([], {
        listCandidates: vi.fn().mockRejectedValue(new Error('db down')),
      });

      await reaper.tick();

      expect(setScalerReapBlocked).toHaveBeenLastCalledWith(false);
      expect(setScalerReapUnseenProvisions).toHaveBeenLastCalledWith(0);
    });

    it('unblocks the gauge once the cluster view returns', async () => {
      let visible = false;
      const { reaper } = leadingReaper([candidate({ ageMs: 1000, adoptedBy: 'orch-b' })], {
        canReap: () => visible,
      });

      await reaper.tick();
      expect(lastGauge(setScalerReapBlocked)).toBe(true);

      visible = true;
      await reaper.tick();
      expect(lastGauge(setScalerReapBlocked)).toBe(false);
    });

    it('publishes zeroes on losing leadership', async () => {
      const { reaper } = leadingReaper([candidate({ ageMs: 1000, adoptedBy: 'orch-b' })]);

      await sustain(reaper);
      expect(lastGauge(setScalerReapUnseenProvisions)).toBe(1);

      reaper.onLoseLeadership();

      expect(lastGauge(setScalerReapUnseenProvisions)).toBe(0);
      expect(lastGauge(setScalerReapBlocked)).toBe(false);
    });
  });

  describe('claim purge', () => {
    it('purges claims that expired before the retention cutoff', async () => {
      const { reaper, purgeExpiredClaims } = leadingReaper([]);

      await reaper.tick();

      expect(purgeExpiredClaims).toHaveBeenCalledWith(new Date(NOW - CLAIM_RETENTION_MS));
    });

    it('purges on every tick, not only when there are candidates', async () => {
      const { reaper, purgeExpiredClaims } = leadingReaper([
        candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' }),
      ]);

      await reaper.tick();
      vi.setSystemTime(NOW + INTERVAL_MS);
      await reaper.tick();

      expect(purgeExpiredClaims).toHaveBeenCalledTimes(2);
    });
  });

  describe('failure isolation', () => {
    it('does not throw when listing candidates fails, and still purges claims', async () => {
      const { reaper, purgeExpiredClaims } = leadingReaper([], {
        listCandidates: vi.fn().mockRejectedValue(new Error('db down')),
      });

      await expect(reaper.tick()).resolves.toBeUndefined();
      expect(purgeExpiredClaims).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the claim purge fails', async () => {
      const { reaper } = leadingReaper([], {
        purgeExpiredClaims: vi.fn().mockRejectedValue(new Error('db down')),
      });

      await expect(reaper.tick()).resolves.toBeUndefined();
    });

    it('keeps reaping the rest of the sweep after one teardown throws', async () => {
      const emitScaleDown = vi
        .fn()
        .mockRejectedValueOnce(new Error('emit failed'))
        .mockResolvedValue(undefined);
      const { reaper } = leadingReaper(
        [
          candidate({ ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' }),
          candidate({ agentId: 'a2', ageMs: 10 * SPAWN_TIMEOUT_MS, ownerInstanceId: 'orch-a' }),
        ],
        { emitScaleDown },
      );

      await expect(sustain(reaper)).resolves.toBeUndefined();
      expect(emitScaleDown.mock.calls.map((c) => c[0].agentId)).toEqual(['a1', 'a2']);
    });
  });
});
