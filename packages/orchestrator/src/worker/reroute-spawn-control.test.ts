import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ScalerEventType,
  type JobReroute,
  type PeerScalerEvent,
  type RerouteSpawnRetry,
} from '@kici-dev/engine';
import { AgentRegistry } from '../agent/registry.js';
import { Dispatcher } from '../agent/dispatcher.js';
import type { JobQueue } from '../queue/job-queue.js';
import type { ScalerEvent } from '../scaler/types.js';
import { InMemoryJobQueue } from './in-memory-job-queue.js';
import { InMemoryExecutionTracker } from './in-memory-execution-tracker.js';
import { createRerouteSpawnControl, type ScaleRequest } from './reroute-spawn-control.js';

const RUN = 'run-1';
const JOB = 'job-1';

function rerouteMsg(spawnRetry?: RerouteSpawnRetry): JobReroute {
  return {
    type: 'job.reroute',
    messageId: 'm-1',
    jobId: JOB,
    runId: RUN,
    deliveryId: 'd-1',
    routingKey: 'rk',
    event: 'push',
    action: null,
    payload: {},
    jobName: 'build',
    workflowName: 'ci',
    runsOnLabels: [['linux']],
    triedConnections: ['coord'],
    maxHops: 3,
    coordinatorId: 'coord',
    ...(spawnRetry && { spawnRetry }),
  };
}

function failed(agentId: string): ScalerEvent {
  return {
    agentId,
    eventType: ScalerEventType.enum['scaler.failed'],
    detail: 'no such image',
    timestampMs: 1,
  };
}

interface Relay {
  msg: PeerScalerEvent;
  ownedAtRelay: boolean;
}

/**
 * The worker's assembly with a real queue, tracker and dispatcher: the same
 * construction `bootstrapWorker` performs, with the scaler request faked.
 */
async function setup(
  spawnRetry: RerouteSpawnRetry | undefined,
  defaults: RerouteSpawnRetry = { maxAttempts: 3, backoffMs: 1000 },
) {
  const queue = new InMemoryJobQueue();
  const forward = vi.fn();
  const executionTracker = new InMemoryExecutionTracker({ onStatusForward: forward });
  const jobOwnership = new Map<string, string>();
  const relays: Relay[] = [];
  const sendToOwningCoord = (jobId: string, msg: PeerScalerEvent) => {
    relays.push({ msg, ownedAtRelay: jobOwnership.has(jobId) });
  };
  // Each spawn names its agent a1, a2, … in call order, as the scaler does.
  let spawned = 0;
  const requestScale: Mock<ScaleRequest> = vi.fn<ScaleRequest>(async () => ({
    action: 'spawning',
    backendType: 'container',
    agentId: `a${++spawned}`,
  }));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let dispatcher: Dispatcher | null = null;
  const control = createRerouteSpawnControl({
    queue,
    getDispatcher: () => dispatcher!,
    executionTracker,
    jobOwnership,
    sendToOwningCoord,
    defaults,
    logger,
  });
  dispatcher = new Dispatcher({
    registry: new AgentRegistry(),
    queue: queue as unknown as JobQueue,
    metrics: {
      incJobsDispatched: () => {},
      setQueueDepth: () => {},
      incScalerRedispatch: () => {},
    },
    onDispatch: async () => {},
    onNoMatchingAgent: control.wrapScaleRequest(requestScale),
  });

  const msg = rerouteMsg(spawnRetry);
  control.registerReroute(msg);
  const result = await dispatcher.dispatch({
    jobId: JOB,
    runId: RUN,
    workflowName: 'ci',
    jobName: 'build',
    runsOnLabels: ['linux'],
    jobConfig: {},
    repoUrl: 'https://example.invalid/repo.git',
    ref: 'main',
    sha: 'abc',
    deliveryId: 'd-1',
    provider: 'github',
    providerContext: {},
    routingKey: 'rk',
  });
  jobOwnership.set(JOB, 'wss://coord');
  await executionTracker.onExecutionStarted(
    RUN,
    'ci',
    'github',
    '',
    'main',
    'abc',
    'd-1',
    {},
    null,
    [{ jobId: JOB, jobName: 'build' }],
  );
  return {
    queue,
    executionTracker,
    jobOwnership,
    relays,
    requestScale,
    control,
    dispatcher,
    forward,
    logger,
    dispatchResult: result,
  };
}

const finals = (relays: Relay[]) => relays.map((r) => r.msg.final);

describe('createRerouteSpawnControl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts one spawn on dispatch and keeps the job queued', async () => {
    const s = await setup({ maxAttempts: 3, backoffMs: 1000 });
    expect(s.dispatchResult.status).toBe('queued');
    expect(s.requestScale).toHaveBeenCalledTimes(1);
    expect(s.queue.isPending(JOB)).toBe(true);
  });

  it('(i) a job that recovers on its last attempt still runs', async () => {
    const s = await setup({ maxAttempts: 3, backoffMs: 1000 });

    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    await vi.advanceTimersByTimeAsync(999);
    // fails-when: the worker retries without waiting the backoff
    expect(s.requestScale).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.requestScale).toHaveBeenCalledTimes(2);

    s.control.onScalerEvent(RUN, JOB, failed('a2'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.requestScale).toHaveBeenCalledTimes(3);
    expect(finals(s.relays)).toEqual([false, false]);

    // The third spawn's agent takes the job.
    expect(await s.queue.dequeueById(JOB, ['linux'])).not.toBeNull();
    s.control.onDelivered(JOB);
    // breaks-if-wrong: a job that recovers on its last attempt still runs
    expect(s.jobOwnership.has(JOB)).toBe(true);
    expect(s.executionTracker.getRunStatus(RUN)?.jobs.has(JOB)).toBe(true);
  });

  it('(ii) gives an exhausted job back and never spawns for it again', async () => {
    const s = await setup({ maxAttempts: 3, backoffMs: 1000 });

    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    await vi.advanceTimersByTimeAsync(1000);
    s.control.onScalerEvent(RUN, JOB, failed('a2'));
    await vi.advanceTimersByTimeAsync(1000);
    s.control.onScalerEvent(RUN, JOB, failed('a3'));
    await vi.advanceTimersByTimeAsync(0);

    expect(finals(s.relays)).toEqual([false, false, true]);
    // The final verdict left before the release removed the job's owner.
    expect(s.relays.every((r) => r.ownedAtRelay)).toBe(true);
    expect(s.queue.isPending(JOB)).toBe(false);
    expect(await s.queue.getFullJobById(JOB)).toBeNull();
    expect(s.jobOwnership.has(JOB)).toBe(false);
    expect(s.executionTracker.getRunStatus(RUN)).toBeNull();
    expect(s.forward).not.toHaveBeenCalled();

    expect(await s.dispatcher.retryPendingScaleRequests()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    // fails-when: the worker keeps retrying an exhausted job
    expect(s.requestScale).toHaveBeenCalledTimes(3);
  });

  it('a duplicate final failure releases the job once', async () => {
    const s = await setup({ maxAttempts: 1, backoffMs: 1000 });
    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    await vi.advanceTimersByTimeAsync(0);
    expect(finals(s.relays)).toEqual([true, undefined]);
    expect(
      s.logger.warn.mock.calls.filter(([m]) => String(m).includes('retries exhausted')),
    ).toHaveLength(1);
  });

  it('a repeated report of one failed spawn carries no verdict', async () => {
    const s = await setup({ maxAttempts: 3, backoffMs: 1000 });
    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    await vi.advanceTimersByTimeAsync(1000);
    s.control.onScalerEvent(RUN, JOB, failed('a2'));
    // fails-when: the repeat relays `final: false`, so the coordinator counts two
    // attempts for one spawn and fails the job over while the worker still has one left
    // breaks-if-wrong: a second agent's failure still relays its `final: false`
    expect(finals(s.relays)).toEqual([false, undefined, false]);
    expect('final' in s.relays[1].msg).toBe(false);
    expect(s.queue.isPending(JOB)).toBe(true);
  });

  it('(iii) a cancel during the backoff stops the retry', async () => {
    const s = await setup({ maxAttempts: 3, backoffMs: 1000 });
    s.control.onScalerEvent(RUN, JOB, failed('a1'));

    expect(await s.control.releaseQueued(RUN, JOB)).toEqual([JOB]);
    await vi.advanceTimersByTimeAsync(5000);
    // fails-when: a job its coordinator cancelled is spawned again
    expect(s.requestScale).toHaveBeenCalledTimes(1);
    expect(s.jobOwnership.has(JOB)).toBe(false);
  });

  it('(iv) a capacity-freed pass does not start a second spawn while one is in flight', async () => {
    const s = await setup({ maxAttempts: 3, backoffMs: 1000 });
    // fails-when: two spawns start for one rerouted job
    expect(await s.dispatcher.retryPendingScaleRequests()).toBe(0);
    expect(s.requestScale).toHaveBeenCalledTimes(1);
  });

  it('a spawn the scaler declined frees the attempt for the next pass', async () => {
    const s = await setup({ maxAttempts: 3, backoffMs: 1000 });
    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    s.requestScale.mockResolvedValueOnce({ action: 'at-capacity' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.requestScale).toHaveBeenCalledTimes(2);
    // breaks-if-wrong: a job whose retry hit a full scaler is stranded
    expect(await s.dispatcher.retryPendingScaleRequests()).toBe(1);
    expect(s.requestScale).toHaveBeenCalledTimes(3);
  });

  it('a retry that meets the scaler launch deferral waits it out without being charged', async () => {
    const s = await setup({ maxAttempts: 3, backoffMs: 1000 });
    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    s.requestScale.mockResolvedValueOnce({
      action: 'skipped',
      reason: 'scaler `bm` failed to start an agent; deferring for 30s before asking again.',
      retryAfterMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.requestScale).toHaveBeenCalledTimes(2);

    // fails-when: the deferred retry is dropped — a worker has no pending sweep,
    // so the job would sit until the coordinator's spawn window runs out.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.requestScale).toHaveBeenCalledTimes(3);
    // breaks-if-wrong: the deferral spends an attempt (one relay, one verdict).
    expect(finals(s.relays)).toEqual([false]);
  });

  it('(v) an older coordinator sends no budget: the worker default applies', async () => {
    const s = await setup(undefined, { maxAttempts: 2, backoffMs: 1000 });
    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    await vi.advanceTimersByTimeAsync(1000);
    s.control.onScalerEvent(RUN, JOB, failed('a2'));
    expect(finals(s.relays)).toEqual([false, true]);
  });

  it('(vi) relays carry no verdict for other events or a job an agent took', async () => {
    const s = await setup({ maxAttempts: 1, backoffMs: 1000 });
    s.control.onScalerEvent(RUN, JOB, {
      agentId: 'a1',
      eventType: ScalerEventType.enum['scaler.ready'],
      detail: 'ready',
      timestampMs: 1,
    });
    await s.queue.dequeueById(JOB, ['linux']);
    s.control.onDelivered(JOB);
    // breaks-if-wrong: a failure after an agent took the job is charged to the spawn budget
    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    await vi.advanceTimersByTimeAsync(0);

    expect(s.relays.map((r) => 'final' in r.msg)).toEqual([false, false]);
    expect(s.jobOwnership.has(JOB)).toBe(true);
  });

  it('(vii) a terminal job is not re-driven after its backoff', async () => {
    const s = await setup({ maxAttempts: 3, backoffMs: 1000 });
    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    s.control.onJobTerminal(JOB);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.requestScale).toHaveBeenCalledTimes(1);
  });

  it('(viii) a forgotten reroute is untracked', async () => {
    const s = await setup({ maxAttempts: 1, backoffMs: 1000 });
    s.control.forgetReroute(JOB);
    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    await vi.advanceTimersByTimeAsync(0);
    expect('final' in s.relays[0].msg).toBe(false);
    expect(s.queue.isPending(JOB)).toBe(true);
  });

  it('a superseded spawn failing late is not charged and starts no second spawn', async () => {
    const s = await setup({ maxAttempts: 2, backoffMs: 1000 });
    // a1's agent registered and took the job, then dropped it: the job is back.
    expect(await s.queue.dequeueById(JOB, ['linux'])).not.toBeNull();
    s.control.onDelivered(JOB);
    expect(await s.queue.requeue(JOB)).toBe(1);
    // The capacity-freed re-drive starts a2.
    expect(await s.dispatcher.retryPendingScaleRequests()).toBe(1);
    expect(s.requestScale).toHaveBeenCalledTimes(2);

    // fails-when: the late failure is charged — the gate opens while a2 is in
    // flight, and the backoff re-drive starts a concurrent third spawn
    s.control.onScalerEvent(RUN, JOB, failed('a1'));
    expect('final' in s.relays[0].msg).toBe(false);
    expect(await s.dispatcher.retryPendingScaleRequests()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.requestScale).toHaveBeenCalledTimes(2);
    expect(s.queue.isPending(JOB)).toBe(true);

    // breaks-if-wrong: the gate holder's own failure is still charged
    s.control.onScalerEvent(RUN, JOB, failed('a2'));
    expect(s.relays[1].msg.final).toBe(false);
  });
});
