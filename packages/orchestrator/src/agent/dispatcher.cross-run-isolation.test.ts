/**
 * An agent's authority over a `jobId` is bounded by the Dispatcher's three
 * ownership windows — `agentJobs` (active dispatch), `recoveringJobs`
 * (reconnect grace), `completedJobs` (post-completion grace,
 * `Dispatcher.GRACE_WINDOW_MS = 30_000`). Outside them
 * `Dispatcher.isJobOwnedByAgent` is false and `OwnershipTracker.checkOwnership`
 * (on every jobId-bearing inbound message in `agent-handler.ts`) rejects.
 *
 * Trust model (must hold): a token's WS lifetime spans many runs (no per-run
 * token), so per-run authority is the (agentId, jobId) gate. A compromised
 * agent or stolen token that serviced run R1 cannot, after R1 completes, claim:
 *
 *   1. a jobId owned by another agent (cross-agent access);
 *   2. its own completed jobId after the 30-second grace window;
 *   3. a jobId never dispatched to anyone.
 *
 * Outbound jobId-bearing messages (`job.dispatch` / `job.cancel` /
 * `cache.upload.response` / `event.emit.response`) are scoped to a job
 * currently or imminently dispatched to that agent; no orch→agent message
 * delivers data for an arbitrary historical jobId.
 *
 * The gate's integration into `agent-handler.ts` is covered by the
 * `agent-handler.test.ts` ownership-tracker scenarios.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Dispatcher, type DispatchMetrics } from './dispatcher.js';
import { AgentRegistry } from './registry.js';
import type { JobQueue, QueuedJob, QueuedJobInput } from '../queue/job-queue.js';
import { canonicalizeLabels } from '@kici-dev/engine';
import { mockWs } from '../__test-helpers__/mock-ws.js';

/**
 * Must mirror `Dispatcher.GRACE_WINDOW_MS` (private static in
 * dispatcher.ts). Test uses the literal so a future
 * regression that quietly extends the window would be visible here.
 */
const GRACE_WINDOW_MS = 30_000;

/**
 * A `QueuedJob` as the queue hands one back. Label selectors are given as plain
 * strings and folded here, exactly as `rowToQueuedJob` folds what it reads.
 */
function makeQueuedJob(
  overrides: Partial<Omit<QueuedJob, 'runsOnLabels' | 'excludeLabels'>> & {
    runsOnLabels?: string[];
    excludeLabels?: string[];
  } = {},
): QueuedJob {
  const { runsOnLabels, excludeLabels, ...rest } = overrides;
  return {
    ...makeQueuedJobDefaults(),
    ...rest,
    runsOnLabels: canonicalizeLabels(runsOnLabels ?? ['linux']),
    excludeLabels: canonicalizeLabels(excludeLabels ?? []),
  };
}

function makeQueuedJobDefaults(): QueuedJob {
  return {
    id: 'queued-job-1',
    runId: 'run-1',
    workflowName: 'ci',
    jobName: 'build',
    runsOnLabels: [],
    jobConfig: { timeout: 300 },
    repoUrl: 'https://github.com/owner/repo.git',
    ref: 'refs/heads/main',
    sha: 'abc123',
    status: 'pending',
    createdAt: '2026-02-08T10:00:00.000Z',
    expiresAt: '2026-02-08T10:10:00.000Z',
    deliveryId: 'delivery-1',
    provider: 'github',
    providerContext: { installationId: 42 },
    excludeLabels: [],
    routingKey: 'github:42',
  };
}

function mockMetrics(): DispatchMetrics {
  return {
    incJobsDispatched: vi.fn(),
    setQueueDepth: vi.fn(),
  };
}

function mockQueue(jobs: QueuedJob[] = []): JobQueue {
  let dequeueIndex = 0;
  return {
    enqueue: vi.fn().mockResolvedValue('enqueued-job-id'),
    insertDispatched: vi.fn().mockImplementation(async (input: QueuedJobInput) => ({
      id: input.jobId ?? crypto.randomUUID(),
      inserted: true,
    })),
    dequeueForLabels: vi
      .fn()
      .mockImplementation(async () => (dequeueIndex < jobs.length ? jobs[dequeueIndex++] : null)),
    dequeueById: vi.fn().mockImplementation(async (id: string) => jobs.find((j) => j.id === id)),
    markDispatched: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markExpired: vi.fn().mockResolvedValue(0),
    getDepth: vi.fn().mockResolvedValue(0),
    getPendingJobs: vi.fn().mockResolvedValue(jobs),
    markRecovering: vi.fn().mockResolvedValue(undefined),
    markFailedIfRecovering: vi.fn().mockResolvedValue(true),
    markDispatchedIfRecovering: vi.fn().mockResolvedValue(true),
    getJobById: vi.fn().mockImplementation(async (jobId: string) => ({
      id: jobId,
      runId: 'run-1',
      status: 'dispatched',
    })),
    getJobsByStatus: vi.fn().mockResolvedValue([]),
    getDispatchedJobIdsByRunId: vi.fn().mockResolvedValue([]),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    requeue: vi.fn().mockResolvedValue(1),
    getFullJobById: vi.fn().mockResolvedValue(null),
    setAckDeadline: vi.fn().mockResolvedValue(undefined),
    clearAckDeadline: vi.fn().mockResolvedValue(undefined),
    getDispatchedAwaitingAck: vi.fn().mockResolvedValue([]),
    listExpiredAckDeadlines: vi.fn().mockResolvedValue([]),
  } as unknown as JobQueue;
}

describe('cross-run isolation — agent authority bounded by ownership windows', () => {
  let registry: AgentRegistry;
  let metrics: DispatchMetrics;
  let onDispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new AgentRegistry();
    metrics = mockMetrics();
    onDispatch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects cross-agent ownership claims (agent-1 cannot claim agent-2 jobId)', async () => {
    // The canonical cross-run-via-different-agent primitive.
    registry.register('agent-1', mockWs(), ['linux']);
    registry.register('agent-2', mockWs(), ['linux']);
    registry.incrementActiveJobs('agent-1'); // make agent-1 busy so dispatch picks agent-2

    const queue = mockQueue();
    const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });
    const result = await dispatcher.dispatch({
      runId: 'run-2',
      workflowName: 'ci',
      jobName: 'build',
      runsOnLabels: ['linux'],
      jobConfig: {},
      repoUrl: 'https://github.com/owner/repo.git',
      ref: 'refs/heads/main',
      sha: 'abc123',
      deliveryId: 'd-2',
      provider: 'github',
      providerContext: {},
      routingKey: 'github:42',
    });
    expect(result.status).toBe('dispatched');
    if (result.status !== 'dispatched') return;
    expect(result.agentId).toBe('agent-2');
    const agent2JobId = result.jobId;

    expect(dispatcher.isJobOwnedByAgent('agent-2', agent2JobId)).toBe(true);

    expect(dispatcher.isJobOwnedByAgent('agent-1', agent2JobId)).toBe(false);
  });

  it('rejects post-completion access after the 30-second grace window expires', async () => {
    // The 30s grace window accepts in-flight messages (log.chunk / step.status)
    // that crossed the wire just before job.status='completed'; past it, a
    // message claiming the completed jobId is rejected.
    registry.register('agent-1', mockWs(), ['linux']);
    const queue = mockQueue();
    const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });
    const result = await dispatcher.dispatch({
      runId: 'run-1',
      workflowName: 'ci',
      jobName: 'build',
      runsOnLabels: ['linux'],
      jobConfig: {},
      repoUrl: 'https://github.com/owner/repo.git',
      ref: 'refs/heads/main',
      sha: 'abc123',
      deliveryId: 'd-1',
      provider: 'github',
      providerContext: {},
      routingKey: 'github:42',
    });
    expect(result.status).toBe('dispatched');
    if (result.status !== 'dispatched') return;
    const jobId = result.jobId;

    // While active: ownership holds.
    expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(true);

    // Mark complete: ownership transitions into the grace window.
    dispatcher.onJobComplete('agent-1', jobId);
    expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(true);

    // Just before the grace window expires: ownership still holds.
    vi.advanceTimersByTime(GRACE_WINDOW_MS - 1);
    expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(true);

    // Past the grace window: ownership dies.
    vi.advanceTimersByTime(2);
    expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(false);
  });

  it('rejects access to a jobId that was never dispatched to anyone', async () => {
    // A fabricated jobId in a log.chunk / step.status / cache.upload.* message:
    // the gate never says yes for an unknown jobId, even for an authenticated
    // agent.
    registry.register('agent-1', mockWs(), ['linux']);
    const queue = mockQueue();
    const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

    expect(dispatcher.isJobOwnedByAgent('agent-1', 'never-dispatched-job-id')).toBe(false);
    expect(dispatcher.isJobOwnedByAgent('agent-1', '00000000-0000-0000-0000-000000000000')).toBe(
      false,
    );
  });

  it('rejects access to a different agent`s job even after that agent disconnects mid-run', async () => {
    // agent-2's job sits in recoveringJobs awaiting its reconnect; agent-1,
    // never the owner, must not claim it.
    registry.register('agent-1', mockWs(), ['linux']);
    const ws2 = mockWs();
    registry.register('agent-2', ws2, ['linux']);
    registry.incrementActiveJobs('agent-1'); // force dispatch onto agent-2

    const queue = mockQueue();
    const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });
    const result = await dispatcher.dispatch({
      runId: 'run-2',
      workflowName: 'ci',
      jobName: 'build',
      runsOnLabels: ['linux'],
      jobConfig: {},
      repoUrl: 'https://github.com/owner/repo.git',
      ref: 'refs/heads/main',
      sha: 'abc123',
      deliveryId: 'd-2',
      provider: 'github',
      providerContext: {},
      routingKey: 'github:42',
    });
    expect(result.status).toBe('dispatched');
    if (result.status !== 'dispatched') return;
    const jobId = result.jobId;
    expect(result.agentId).toBe('agent-2');

    // agent-2 disconnects mid-run — its job moves into recoveringJobs.
    await dispatcher.onAgentDisconnect('agent-2');

    // Preserved during reconnect grace, so the reconnecting WS can resume it.
    expect(dispatcher.isJobOwnedByAgent('agent-2', jobId)).toBe(true);

    expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(false);
  });
});
