import { describe, it, expect, vi } from 'vitest';
import type { PeerJobCancel } from '@kici-dev/engine';
import { DispatchQueueStatus } from '../queue/job-queue.js';
import {
  deliverPeerJobCancel,
  PeerCancelOutcome,
  readDispatchedAgents,
  type DispatchedAgent,
  type PeerJobCancelDeps,
} from './peer-job-cancel.js';

const OPEN = 1;
const CLOSED = 3;
const Outcome = PeerCancelOutcome.enum;

function socket(readyState = OPEN) {
  return { readyState, send: vi.fn(), close: vi.fn() };
}

function makeDeps(over: {
  mapped?: Record<string, string>;
  sockets?: Record<string, ReturnType<typeof socket>>;
  dispatched?: DispatchedAgent[] | Error;
  noDatabase?: boolean;
  trackedForRun?: string[];
  /** Wire a worker's queued-job release returning these ids (or throwing). */
  releaseQueued?: string[] | Error;
}) {
  const warn = vi.fn();
  const info = vi.fn();
  const lookup = vi.fn(async (): Promise<DispatchedAgent[]> => {
    if (over.dispatched instanceof Error) throw over.dispatched;
    return over.dispatched ?? [];
  });
  const release = vi.fn(async (): Promise<string[]> => {
    if (over.releaseQueued instanceof Error) throw over.releaseQueued;
    return over.releaseQueued ?? [];
  });
  const deps: PeerJobCancelDeps = {
    dispatcher: {
      getAgentIdForJob: (jobId: string) => over.mapped?.[jobId] ?? null,
      getTrackedJobIdsForRun: () => over.trackedForRun ?? [],
    },
    registry: {
      get: (agentId: string) =>
        over.sockets?.[agentId] ? { ws: over.sockets[agentId] } : undefined,
    } as unknown as PeerJobCancelDeps['registry'],
    ...(over.noDatabase ? {} : { lookupDispatched: lookup }),
    ...(over.releaseQueued !== undefined && { releaseQueued: release }),
    logger: { info, warn },
  };
  return { deps, warn, info, lookup, release };
}

const cancel = (extra: Partial<PeerJobCancel> = {}): PeerJobCancel => ({
  type: 'peer.job.cancel',
  runId: 'run-1',
  jobId: 'job-1',
  reason: 'run cancelled via API',
  ...extra,
});

const sentFrame = (ws: ReturnType<typeof socket>) =>
  JSON.parse(ws.send.mock.calls[0][0] as string) as Record<string, unknown>;

describe('deliverPeerJobCancel', () => {
  it('delivers from the dispatcher map without reading the database', async () => {
    const ws = socket();
    const { deps, lookup, info } = makeDeps({
      mapped: { 'job-1': 'agent-1' },
      sockets: { 'agent-1': ws },
    });

    const result = await deliverPeerJobCancel(deps, cancel());

    expect(result).toEqual([{ jobId: 'job-1', agentId: 'agent-1', outcome: Outcome.delivered }]);
    expect(sentFrame(ws)).toMatchObject({ type: 'job.cancel', runId: 'run-1', jobId: 'job-1' });
    expect(sentFrame(ws)).not.toHaveProperty('force');
    // breaks-if-wrong: the hot path stays a map read.
    expect(lookup).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Peer job cancel delivered', {
      runId: 'run-1',
      delivered: 1,
      force: false,
    });
  });

  it('falls back to the dispatch record when the map misses', async () => {
    const ws = socket();
    const { deps, lookup } = makeDeps({
      dispatched: [{ jobId: 'job-1', agentId: 'agent-1' }],
      sockets: { 'agent-1': ws },
    });

    const result = await deliverPeerJobCancel(deps, cancel());

    // fails-when: the handler consults only the map — an agent that reconnected
    // here from a sibling never hears the cancel.
    expect(lookup).toHaveBeenCalledWith('run-1', 'job-1');
    expect(result[0].outcome).toBe(Outcome.delivered);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('warns, and does not throw, when neither the map nor the database knows the job', async () => {
    const { deps, warn } = makeDeps({ dispatched: [] });

    const result = await deliverPeerJobCancel(deps, cancel());

    // fails-when: a miss is dropped in silence.
    expect(result).toEqual([{ jobId: 'job-1', agentId: null, outcome: Outcome['not-tracked'] }]);
    expect(warn).toHaveBeenCalledWith(
      'Peer job cancel not delivered',
      expect.objectContaining({ runId: 'run-1', jobId: 'job-1', outcome: Outcome['not-tracked'] }),
    );
  });

  it('warns when the dispatch record names no agent', async () => {
    const { deps, warn } = makeDeps({ dispatched: [{ jobId: 'job-1', agentId: null }] });

    const result = await deliverPeerJobCancel(deps, cancel());

    expect(result).toEqual([{ jobId: 'job-1', agentId: null, outcome: Outcome['not-tracked'] }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns when the owning agent has no open socket here', async () => {
    const { deps, warn } = makeDeps({
      dispatched: [{ jobId: 'job-1', agentId: 'agent-1' }],
      sockets: { 'agent-1': socket(CLOSED) },
    });

    const result = await deliverPeerJobCancel(deps, cancel());

    expect(result[0]).toEqual({
      jobId: 'job-1',
      agentId: 'agent-1',
      outcome: Outcome['agent-not-connected'],
    });
    expect(warn).toHaveBeenCalledWith(
      'Peer job cancel not delivered',
      expect.objectContaining({ agentId: 'agent-1', outcome: Outcome['agent-not-connected'] }),
    );
  });

  it('warns and resolves when the database read fails', async () => {
    const { deps, warn } = makeDeps({ dispatched: new Error('connection terminated') });

    await expect(deliverPeerJobCancel(deps, cancel())).resolves.toEqual([
      { jobId: 'job-1', agentId: null, outcome: Outcome['lookup-failed'] },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'Peer job cancel not delivered',
      expect.objectContaining({
        outcome: Outcome['lookup-failed'],
        error: 'connection terminated',
      }),
    );
  });

  it('carries force onto the agent frame', async () => {
    const ws = socket();
    const { deps } = makeDeps({ mapped: { 'job-1': 'agent-1' }, sockets: { 'agent-1': ws } });

    await deliverPeerJobCancel(deps, cancel({ force: true }));

    // fails-when: the receiver drops force and the agent runs its graceful hooks.
    expect(sentFrame(ws)).toMatchObject({ force: true });
  });

  it('cancels every dispatched job of the run when jobId is absent', async () => {
    const a = socket();
    const b = socket();
    const { deps, lookup } = makeDeps({
      dispatched: [
        { jobId: 'job-1', agentId: 'agent-1' },
        { jobId: 'job-2', agentId: 'agent-2' },
      ],
      sockets: { 'agent-1': a, 'agent-2': b },
    });

    const result = await deliverPeerJobCancel(deps, cancel({ jobId: undefined }));

    expect(lookup).toHaveBeenCalledWith('run-1', undefined);
    expect(result.map((r) => r.outcome)).toEqual([Outcome.delivered, Outcome.delivered]);
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it('uses the dispatcher for a run-wide cancel on a worker, which has no database', async () => {
    const ws = socket();
    const { deps } = makeDeps({
      noDatabase: true,
      trackedForRun: ['job-9'],
      mapped: { 'job-9': 'agent-9' },
      sockets: { 'agent-9': ws },
    });

    const result = await deliverPeerJobCancel(deps, cancel({ jobId: undefined }));

    expect(result).toEqual([{ jobId: 'job-9', agentId: 'agent-9', outcome: Outcome.delivered }]);
  });

  it('reports a single-job miss on a worker without a database read', async () => {
    const { deps, warn } = makeDeps({ noDatabase: true });

    const result = await deliverPeerJobCancel(deps, cancel());

    expect(result).toEqual([{ jobId: 'job-1', agentId: null, outcome: Outcome['not-tracked'] }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once when a run-wide cancel finds no job', async () => {
    const { deps, warn } = makeDeps({ noDatabase: true });

    const result = await deliverPeerJobCancel(deps, cancel({ jobId: undefined }));

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Peer job cancel not delivered',
      expect.objectContaining({ runId: 'run-1', outcome: Outcome['not-tracked'] }),
    );
  });
});

describe('readDispatchedAgents', () => {
  function recordingDb(rows: Array<{ id: string; agent_id: string | null }>) {
    const wheres: unknown[][] = [];
    const chain = {
      select: () => chain,
      where: (...args: unknown[]) => {
        wheres.push(args);
        return chain;
      },
      execute: async () => rows,
    };
    const db = { selectFrom: vi.fn(() => chain) } as unknown as Parameters<
      typeof readDispatchedAgents
    >[0];
    return { db, wheres };
  }

  it('reads live rows of the run, narrowed to one job when given', async () => {
    const { db, wheres } = recordingDb([{ id: 'job-1', agent_id: 'agent-1' }]);

    const rows = await readDispatchedAgents(db, 'run-1', 'job-1');

    expect(rows).toEqual([{ jobId: 'job-1', agentId: 'agent-1' }]);
    expect(wheres).toEqual([
      ['run_id', '=', 'run-1'],
      ['status', 'in', [DispatchQueueStatus.Dispatched, DispatchQueueStatus.Recovering]],
      ['id', '=', 'job-1'],
    ]);
  });

  it('reads every live row of the run when no job is given', async () => {
    const { db, wheres } = recordingDb([{ id: 'job-1', agent_id: null }]);

    expect(await readDispatchedAgents(db, 'run-1', undefined)).toEqual([
      { jobId: 'job-1', agentId: null },
    ]);
    expect(wheres).toHaveLength(2);
  });
});

describe('deliverPeerJobCancel on a worker (releaseQueued wired)', () => {
  it('a queued job the worker removed is reported dequeued', async () => {
    const { deps, warn, info } = makeDeps({ noDatabase: true, releaseQueued: ['job-1'] });

    const result = await deliverPeerJobCancel(deps, cancel());

    // fails-when: a queued job survives its coordinator's cancel (reported not-tracked)
    expect(result).toEqual([{ jobId: 'job-1', agentId: null, outcome: Outcome.dequeued }]);
    expect(info).toHaveBeenCalledWith('Peer job cancel removed a queued job', {
      runId: 'run-1',
      jobId: 'job-1',
      removed: 1,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports not-tracked when the worker holds nothing for the job', async () => {
    const { deps, warn } = makeDeps({ noDatabase: true, releaseQueued: [] });

    const result = await deliverPeerJobCancel(deps, cancel());

    expect(result).toEqual([{ jobId: 'job-1', agentId: null, outcome: Outcome['not-tracked'] }]);
    expect(warn).toHaveBeenCalledWith('Peer job cancel not delivered', {
      runId: 'run-1',
      jobId: 'job-1',
      outcome: Outcome['not-tracked'],
    });
  });

  it('a run-scoped cancel removes every queued job of the run', async () => {
    const ws = socket();
    const { deps, release } = makeDeps({
      noDatabase: true,
      mapped: { 'job-3': 'agent-1' },
      sockets: { 'agent-1': ws },
      trackedForRun: ['job-3'],
      releaseQueued: ['job-1', 'job-2'],
    });

    const result = await deliverPeerJobCancel(deps, cancel({ jobId: undefined }));

    expect(release).toHaveBeenCalledWith('run-1', undefined);
    expect(result).toEqual([
      { jobId: 'job-3', agentId: 'agent-1', outcome: Outcome.delivered },
      { jobId: 'job-1', agentId: null, outcome: Outcome.dequeued },
      { jobId: 'job-2', agentId: null, outcome: Outcome.dequeued },
    ]);
  });

  it('a dispatched job is stop-marked before its cancel is delivered', async () => {
    const ws = socket();
    const { deps, release } = makeDeps({
      noDatabase: true,
      mapped: { 'job-1': 'agent-1' },
      sockets: { 'agent-1': ws },
      releaseQueued: [],
    });

    const result = await deliverPeerJobCancel(deps, cancel());

    // breaks-if-wrong: the running job still gets its job.cancel
    expect(result).toEqual([{ jobId: 'job-1', agentId: 'agent-1', outcome: Outcome.delivered }]);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(ws.send.mock.invocationCallOrder[0]);
  });

  it('a failed release is a warn line, and the cancel still reaches the agent', async () => {
    const ws = socket();
    const { deps, warn } = makeDeps({
      noDatabase: true,
      mapped: { 'job-1': 'agent-1' },
      sockets: { 'agent-1': ws },
      releaseQueued: new Error('boom'),
    });

    const result = await deliverPeerJobCancel(deps, cancel());

    expect(result).toEqual([{ jobId: 'job-1', agentId: 'agent-1', outcome: Outcome.delivered }]);
    expect(warn).toHaveBeenCalledWith(
      'Peer job cancel not delivered',
      expect.objectContaining({ outcome: Outcome['lookup-failed'], error: 'boom' }),
    );
  });
});
