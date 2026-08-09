import { describe, expect, it, vi } from 'vitest';
import type { UnroutableCandidate } from './job-queue.js';
import {
  createUnroutableProbeHandler,
  DEFAULT_UNROUTABLE_GRACE_MS,
  probeTickIntervalMs,
  type UnroutableProbeDeps,
} from './unroutable-probe.js';

describe('DEFAULT_UNROUTABLE_GRACE_MS', () => {
  it('mirrors the config default so a 0 startup value derives a sane cadence', () => {
    // Only used to pick the tick interval when the env default is 0. If the
    // config default moves and this does not, a re-enabled probe ticks at the
    // wrong cadence — cheap to assert, easy to forget.
    expect(DEFAULT_UNROUTABLE_GRACE_MS).toBe(120_000);
    expect(probeTickIntervalMs(DEFAULT_UNROUTABLE_GRACE_MS)).toBe(30_000);
  });
});

describe('probeTickIntervalMs', () => {
  it('derives a quarter of the grace', () => {
    expect(probeTickIntervalMs(120_000)).toBe(30_000);
    expect(probeTickIntervalMs(60_000)).toBe(15_000);
  });

  it('clamps to a 5s floor for a tiny grace', () => {
    expect(probeTickIntervalMs(4_000)).toBe(5_000);
    expect(probeTickIntervalMs(1)).toBe(5_000);
  });

  it('clamps to a 30s ceiling for a large grace', () => {
    expect(probeTickIntervalMs(3_600_000)).toBe(30_000);
  });
});

const candidate: UnroutableCandidate = {
  id: 'q-1',
  runId: 'run-1',
  jobName: 'build',
  lastProvisioningError: null,
  runsOnLabels: ['linux', 'gpu'],
  runsOnPatterns: [],
  excludeLabels: [],
  excludePatterns: [],
  unroutableSince: null,
};

function makeDeps(
  overrides: {
    candidates?: UnroutableCandidate[];
    canRoute?: boolean;
    graceMs?: number;
    claimed?: boolean;
  } = {},
) {
  const queue = {
    listUnroutableCandidates: vi.fn().mockResolvedValue(overrides.candidates ?? [candidate]),
    markUnroutableSince: vi.fn().mockResolvedValue(undefined),
    clearUnroutableState: vi.fn().mockResolvedValue(undefined),
    claimUnroutable: vi.fn().mockResolvedValue(overrides.claimed ?? true),
  };
  const setRoutingReason = vi.fn().mockResolvedValue(undefined);
  const terminalize = vi.fn().mockResolvedValue(undefined);
  const onFastFailed = vi.fn();
  const deps: UnroutableProbeDeps = {
    queue,
    getGraceMs: async () => overrides.graceMs ?? 120_000,
    canRouteLabels: () => overrides.canRoute ?? false,
    setRoutingReason,
    terminalize,
    onFastFailed,
  };
  return { deps, queue, setRoutingReason, terminalize, onFastFailed };
}

describe('unroutable probe', () => {
  it('acts on the LIVE grace, so a cluster setting can re-enable a 0 startup default', async () => {
    // The tick is registered unconditionally precisely so this works: an
    // orchestrator booted with KICI_UNROUTABLE_GRACE_MS=0 must still fast-fail
    // once an operator sets `unroutable_grace_ms`, without a restart. Gating
    // registration on the startup default made that impossible while the docs
    // promised the cluster value takes effect within a cache window.
    const { deps, queue, terminalize } = makeDeps({
      candidates: [{ ...candidate, unroutableSince: new Date(Date.now() - 200_000) }],
      graceMs: 120_000, // what the cluster setting now returns, not the 0 default
    });
    await createUnroutableProbeHandler(deps)();
    expect(queue.listUnroutableCandidates).toHaveBeenCalled();
    expect(terminalize).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when the grace is 0 (disabled)', async () => {
    const { deps, queue } = makeDeps({ graceMs: 0 });
    await createUnroutableProbeHandler(deps)();
    expect(queue.listUnroutableCandidates).not.toHaveBeenCalled();
  });

  it('leaves a routable job untouched', async () => {
    const { deps, queue, setRoutingReason, terminalize } = makeDeps({ canRoute: true });
    await createUnroutableProbeHandler(deps)();
    expect(queue.markUnroutableSince).not.toHaveBeenCalled();
    expect(setRoutingReason).not.toHaveBeenCalled();
    expect(terminalize).not.toHaveBeenCalled();
  });

  it('clears a stale clock and reason when a job becomes routable again', async () => {
    const { deps, queue, setRoutingReason, terminalize } = makeDeps({
      canRoute: true,
      candidates: [{ ...candidate, unroutableSince: new Date(Date.now() - 200_000) }],
    });
    await createUnroutableProbeHandler(deps)();
    expect(queue.clearUnroutableState).toHaveBeenCalledWith('q-1');
    expect(setRoutingReason).toHaveBeenCalledWith('run-1', 'build', null);
    // Recovery must never fail a job, even one already past its grace.
    expect(terminalize).not.toHaveBeenCalled();
  });

  it('stamps the clock and writes the reason on the first unroutable tick', async () => {
    const { deps, queue, setRoutingReason, terminalize } = makeDeps();
    await createUnroutableProbeHandler(deps)();
    expect(queue.markUnroutableSince).toHaveBeenCalledWith('q-1', expect.any(Date));
    expect(setRoutingReason).toHaveBeenCalledWith(
      'run-1',
      'build',
      expect.stringContaining('No connected agent or scaler backend currently matches'),
    );
    // The whole point of the grace: visible immediately, not failed yet.
    expect(terminalize).not.toHaveBeenCalled();
  });

  it('does not terminalize while the job is still inside the grace window', async () => {
    const { deps, terminalize } = makeDeps({
      candidates: [{ ...candidate, unroutableSince: new Date(Date.now() - 30_000) }],
      graceMs: 120_000,
    });
    await createUnroutableProbeHandler(deps)();
    expect(terminalize).not.toHaveBeenCalled();
  });

  it('terminalizes once the grace has elapsed, claiming the queue row first', async () => {
    const { deps, queue, terminalize, onFastFailed } = makeDeps({
      candidates: [{ ...candidate, unroutableSince: new Date(Date.now() - 200_000) }],
      graceMs: 120_000,
    });
    await createUnroutableProbeHandler(deps)();
    // The claim is what takes the row out of `Pending`. Without it the job
    // stays dispatchable to a later-connecting agent AND is re-listed (and
    // re-terminalized, and re-counted) on every tick until the queue timeout.
    expect(queue.claimUnroutable).toHaveBeenCalledWith('q-1');
    expect(terminalize).toHaveBeenCalledTimes(1);
    expect(onFastFailed).toHaveBeenCalledTimes(1);
  });

  it('does not terminalize or count when another coordinator claimed the row', async () => {
    // Probe ticks are not leader-gated, so several coordinators reach the
    // elapsed branch for the same job; the queue-row claim is the arbiter and
    // only the winner may forward a terminal status or move the metric.
    const { deps, queue, terminalize, onFastFailed } = makeDeps({
      candidates: [{ ...candidate, unroutableSince: new Date(Date.now() - 200_000) }],
      graceMs: 120_000,
      claimed: false,
    });
    await createUnroutableProbeHandler(deps)();
    expect(queue.claimUnroutable).toHaveBeenCalledWith('q-1');
    expect(terminalize).not.toHaveBeenCalled();
    expect(onFastFailed).not.toHaveBeenCalled();
  });

  it('never terminalizes a job with a recorded provisioning error', async () => {
    // The scaler attempted a spawn, so the labels routed — this is a capacity
    // problem the queue timeout owns, not a fleet/label problem.
    const { deps, terminalize, setRoutingReason } = makeDeps({
      candidates: [
        {
          ...candidate,
          unroutableSince: new Date(Date.now() - 200_000),
          lastProvisioningError: 'image pull failed',
        },
      ],
      graceMs: 120_000,
    });
    await createUnroutableProbeHandler(deps)();
    expect(terminalize).not.toHaveBeenCalled();
    // It reads routable, so its stale clock is cleared rather than advanced.
    expect(setRoutingReason).toHaveBeenCalledWith('run-1', 'build', null);
  });

  it('processes every candidate in the batch independently', async () => {
    const { deps, queue, terminalize } = makeDeps({
      candidates: [
        { ...candidate, id: 'q-1', unroutableSince: null },
        { ...candidate, id: 'q-2', unroutableSince: new Date(Date.now() - 200_000) },
      ],
      graceMs: 120_000,
    });
    await createUnroutableProbeHandler(deps)();
    expect(queue.markUnroutableSince).toHaveBeenCalledWith('q-1', expect.any(Date));
    expect(terminalize).toHaveBeenCalledTimes(1);
    expect(terminalize).toHaveBeenCalledWith(expect.objectContaining({ id: 'q-2' }));
  });
});
