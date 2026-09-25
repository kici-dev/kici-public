import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockInfo } = vi.hoisted(() => ({ mockInfo: vi.fn() }));
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: mockInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

import { canonicalizeLabels } from '@kici-dev/engine';
import { Dispatcher, type DispatchMetrics } from './dispatcher.js';
import { AgentRegistry } from './registry.js';
import { DispatchQueueStatus, type JobQueue, type QueuedJob } from '../queue/job-queue.js';
import { mockWs } from '../__test-helpers__/mock-ws.js';

/**
 * The connected-agent re-drive logs how many pending jobs it placed. A job it
 * claims whose dispatch is then refused, or put back because its sealed secrets
 * cannot be opened here, is not a placement, so it must not be counted or
 * logged as one.
 */
const REFUSED_JOB = 'refused-job';

function queuedJob(id: string): QueuedJob {
  return {
    id,
    runId: `run-${id}`,
    workflowName: 'ci',
    jobName: 'build',
    runsOnLabels: canonicalizeLabels(['linux']),
    jobConfig: {},
    repoUrl: 'https://github.com/owner/repo.git',
    ref: 'refs/heads/main',
    sha: 'abc123',
    status: DispatchQueueStatus.Pending,
    createdAt: '2026-09-24T00:00:00.000Z',
    expiresAt: null,
    deliveryId: `delivery-${id}`,
    provider: 'github',
    providerContext: {},
    excludeLabels: [],
    runsOnPatterns: [],
    excludePatterns: [],
    routingKey: 'github:42',
  };
}

function mockQueue(pending: QueuedJob[]): JobQueue {
  return {
    getDepth: vi.fn().mockResolvedValue(pending.length),
    listPending: vi.fn().mockResolvedValue(pending),
    dequeueById: vi.fn(async (id: string) => pending.find((j) => j.id === id) ?? null),
    markDispatched: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    setAckDeadline: vi.fn().mockResolvedValue(undefined),
    clearAckDeadline: vi.fn().mockResolvedValue(undefined),
  } as unknown as JobQueue;
}

const metrics = {
  incJobsDispatched: vi.fn(),
  setQueueDepth: vi.fn(),
  incScalerRedispatch: vi.fn(),
} as unknown as DispatchMetrics;

/** The `meta` object of every re-drive placement line this test's logger saw. */
function placementLines(): Record<string, unknown>[] {
  return mockInfo.mock.calls
    .filter((c) => String(c[0]).includes('Re-drove pending jobs onto connected idle agents'))
    .map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

describe('Dispatcher connected-agent re-drive logging', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    mockInfo.mockClear();
    registry = new AgentRegistry();
  });

  function dispatcherFor(pending: QueuedJob[]) {
    return new Dispatcher({
      registry,
      queue: mockQueue(pending),
      metrics,
      onDispatch: vi.fn(async (_agentId: string, job: QueuedJob) =>
        job.id === REFUSED_JOB ? { refused: 'no clone credentials' } : undefined,
      ),
      getAckTimeoutMs: async () => 60_000,
    });
  }

  it('counts only the job it sent, and names the one it claimed but did not send', async () => {
    registry.register('a1', mockWs(), ['linux']);
    registry.register('a2', mockWs(), ['linux']);
    const dispatcher = dispatcherFor([queuedJob('sent-job'), queuedJob(REFUSED_JOB)]);

    const placed = await dispatcher.redrivePendingToConnectedAgents();

    // fails-when: the refused claim is counted and logged as a placement
    expect(placed).toBe(1);
    expect(placementLines()).toEqual([{ placed: 1, notSent: 1, scanned: 2 }]);
  });

  it('logs no placement when every job it claimed was refused', async () => {
    registry.register('a1', mockWs(), ['linux']);
    const dispatcher = dispatcherFor([queuedJob(REFUSED_JOB)]);

    const placed = await dispatcher.redrivePendingToConnectedAgents();

    // fails-when: a pass that placed nothing still logs that it re-drove jobs
    expect(placed).toBe(0);
    expect(placementLines()).toEqual([]);
  });
});
