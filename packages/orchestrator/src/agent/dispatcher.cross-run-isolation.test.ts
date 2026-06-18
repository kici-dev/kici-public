/**
 * regression: an agent's authority over a `jobId` is bounded by the
 * Dispatcher's three ownership windows — `agentJobs` (active dispatch),
 * `recoveringJobs` (in-flight reconnect grace), and `completedJobs`
 * (post-completion grace, `Dispatcher.GRACE_WINDOW_MS = 30_000`).
 * Outside those windows, `Dispatcher.isJobOwnedByAgent` returns false
 * and `OwnershipTracker.checkOwnership` (called on every jobId-bearing
 * inbound message in `agent-handler.ts`) rejects the message.
 *
 * Trust model (must hold):
 *   An agent token's WS-connection lifetime spans many runs (KiCI has
 *   no per-run token). Per-run authority is enforced at message-time
 *   by the (agentId, jobId) ownership gate. A compromised agent
 *   (attacker model A5 / A10) holding a token that previously serviced
 *   run R1 cannot, after R1 completes:
 *
 *   1. Send a message claiming a jobId owned by another agent
 *      (cross-agent access).
 *   2. Send a message claiming the agent's own previously-completed
 *      jobId after the 30-second grace window expires
 *      (post-completion-grace expiry).
 *   3. Send a message claiming a jobId that was never dispatched to
 *      anyone (never-dispatched access).
 *
 * Outbound messages (orchestrator → agent) cannot leak prior-run data
 * either: every jobId-bearing outbound message
 * (`job.dispatch` / `job.cancel` / `cache.upload.response` /
 * `event.emit.response`) is scoped to a job that's currently or
 * imminently dispatched to that agent. There is no orch→agent message
 * type that delivers data for an arbitrary historical jobId.
 *
 * This file is the unit-level tripwire for the (agentId, jobId)
 * gate's three windows. The integration of this gate into
 * `agent-handler.ts` is exercised by the existing
 * `agent-handler.test.ts` ownership-tracker scenarios.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Dispatcher, type DispatchMetrics } from './dispatcher.js';
import { AgentRegistry } from './registry.js';
import type { JobQueue, QueuedJob } from '../queue/job-queue.js';
import { mockWs } from '../__test-helpers__/mock-ws.js';

/**
 * Must mirror `Dispatcher.GRACE_WINDOW_MS` (private static, line 81 of
 * dispatcher.ts at time of writing). Test uses the literal so a future
 * regression that quietly extends the window would be visible here.
 */
const GRACE_WINDOW_MS = 30_000;

function makeQueuedJob(overrides: Partial<QueuedJob> = {}): QueuedJob {
  return {
    id: 'queued-job-1',
    runId: 'run-1',
    workflowName: 'ci',
    jobName: 'build',
    runsOnLabels: ['linux'],
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
    ...overrides,
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
    insertDispatched: vi.fn().mockImplementation(async () => crypto.randomUUID()),
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

describe('§5.7 cross-run isolation — agent authority bounded by ownership windows', () => {
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
    // Two agents are registered. agent-2 receives a job dispatch; agent-1
    // never owns that job. agent-1 attempting to claim agent-2's jobId is
    // the canonical cross-run-via-different-agent primitive.
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

    // agent-2's authority over its job is fresh and proper.
    expect(dispatcher.isJobOwnedByAgent('agent-2', agent2JobId)).toBe(true);

    // agent-1 attempting to claim agent-2's jobId is rejected.
    expect(dispatcher.isJobOwnedByAgent('agent-1', agent2JobId)).toBe(false);
  });

  it('rejects post-completion access after the 30-second grace window expires', async () => {
    // The 30s grace window legitimately accepts in-flight messages
    // arriving after the agent reported job completion (log.chunk /
    // step.status that crossed the wire just before the agent emitted
    // job.status='completed'). Past the grace window, ownership dies and
    // any message claiming the completed jobId must be rejected.
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
    // Synthetic jobId an attacker fabricates and references in a
    // log.chunk / step.status / cache.upload.* message hoping to read
    // or write data they were never authorized for. The ownership gate
    // never says yes for an unknown jobId — there's no implicit trust
    // surface here, even for an authenticated agent.
    registry.register('agent-1', mockWs(), ['linux']);
    const queue = mockQueue();
    const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

    expect(dispatcher.isJobOwnedByAgent('agent-1', 'never-dispatched-job-id')).toBe(false);
    expect(dispatcher.isJobOwnedByAgent('agent-1', '00000000-0000-0000-0000-000000000000')).toBe(
      false,
    );
  });

  it('rejects access to a different agent`s job even after that agent disconnects mid-run', async () => {
    // agent-2 starts a job, then disconnects. The job moves into
    // recoveringJobs (waiting for agent-2 to reconnect within its own
    // grace window). agent-1 — never the owner — must not be able to
    // claim ownership of agent-2's recovering job.
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

    // agent-2's ownership during its own reconnect grace is preserved
    // (so its reconnecting WS can pick up the in-flight job).
    expect(dispatcher.isJobOwnedByAgent('agent-2', jobId)).toBe(true);

    // agent-1 — which had nothing to do with this job — is rejected.
    expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(false);
  });
});
