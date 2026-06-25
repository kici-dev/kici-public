import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Dispatcher, type DispatchMetrics } from './dispatcher.js';
import { AgentRegistry } from './registry.js';
import type { JobQueue, QueuedJob, QueuedJobInput } from '../queue/job-queue.js';
import { mockWs } from '../__test-helpers__/mock-ws.js';

function makeJobInput(overrides: Partial<QueuedJobInput> = {}): QueuedJobInput {
  return {
    runId: 'run-1',
    workflowName: 'ci',
    jobName: 'build',
    runsOnLabels: ['linux'],
    jobConfig: { timeout: 300 },
    repoUrl: 'https://github.com/owner/repo.git',
    ref: 'refs/heads/main',
    sha: 'abc123',
    deliveryId: 'delivery-1',
    provider: 'github',
    providerContext: { installationId: 42 },
    routingKey: 'github:42',
    ...overrides,
  };
}

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

/**
 * Create a mock JobQueue with controllable behavior.
 */
function mockQueue(
  options: {
    depth?: number;
    enqueueFails?: boolean;
    dequeueJobs?: QueuedJob[];
    /** Map of jobId -> { runId, status } for getJobById lookups. */
    jobLookups?: Map<string, { id: string; runId: string; status: string }>;
  } = {},
): JobQueue {
  const { depth = 0, enqueueFails = false, dequeueJobs = [], jobLookups } = options;
  let dequeueIndex = 0;

  // Track dispatched job IDs to auto-populate getJobById if no explicit map
  const dispatchedJobIds: string[] = [];

  return {
    enqueue: enqueueFails
      ? vi.fn().mockRejectedValue(new Error('queue full'))
      : vi.fn().mockResolvedValue('enqueued-job-id'),
    insertDispatched: vi.fn().mockImplementation(async () => {
      const id = crypto.randomUUID();
      dispatchedJobIds.push(id);
      return id;
    }),
    dequeueForLabels: vi.fn().mockImplementation(async () => {
      if (dequeueIndex < dequeueJobs.length) {
        return dequeueJobs[dequeueIndex++];
      }
      return null;
    }),
    dequeueById: vi.fn().mockImplementation(async (jobId: string) => {
      const match = dequeueJobs.find((j) => j.id === jobId);
      return match ?? null;
    }),
    dequeueByPinnedAgent: vi.fn().mockImplementation(async (agentId: string) => {
      const idx = dequeueJobs.findIndex((j) => j.pinnedAgentId === agentId);
      if (idx === -1) return null;
      return dequeueJobs.splice(idx, 1)[0];
    }),
    markDispatched: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markExpired: vi.fn().mockResolvedValue(0),
    getDepth: vi.fn().mockResolvedValue(depth),
    getPendingJobs: vi.fn().mockResolvedValue(dequeueJobs),
    // Recovery methods
    markRecovering: vi.fn().mockResolvedValue(undefined),
    markFailedIfRecovering: vi.fn().mockResolvedValue(true),
    markDispatchedIfRecovering: vi.fn().mockResolvedValue(true),
    getJobById: vi.fn().mockImplementation(async (jobId: string) => {
      if (jobLookups?.has(jobId)) return jobLookups.get(jobId)!;
      // Default: return a minimal result with the jobId and run-1
      return { id: jobId, runId: 'run-1', status: 'dispatched' };
    }),
    getJobsByStatus: vi.fn().mockResolvedValue([]),
    getDispatchedJobIdsByRunId: vi.fn().mockResolvedValue([]),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    getRecoveringJobs: vi.fn().mockResolvedValue([]),
    sweepExpiredRecoveries: vi.fn().mockResolvedValue([]),
    hasAgentOwnedJob: vi.fn().mockResolvedValue(false),
    // Dispatch-ack methods
    requeue: vi.fn().mockResolvedValue(1),
    getFullJobById: vi.fn().mockResolvedValue(null),
    setAckDeadline: vi.fn().mockResolvedValue(undefined),
    clearAckDeadline: vi.fn().mockResolvedValue(undefined),
    getDispatchedAwaitingAck: vi.fn().mockResolvedValue([]),
    listExpiredAckDeadlines: vi.fn().mockResolvedValue([]),
  } as unknown as JobQueue;
}

// ── Tests ───────────────────────────────────────────────────────

describe('Dispatcher', () => {
  let registry: AgentRegistry;
  let metrics: DispatchMetrics;
  let onDispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new AgentRegistry();
    metrics = mockMetrics();
    onDispatch = vi.fn();
  });

  describe('dispatch', () => {
    it('dispatches to available agent and calls onDispatch callback', async () => {
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('dispatched');
      if (result.status === 'dispatched') {
        expect(result.agentId).toBe('agent-1');
        expect(result.jobId).toBeDefined();
      }

      // onDispatch should be called with the agent ID and a job object
      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(onDispatch).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          runId: 'run-1',
          workflowName: 'ci',
          jobName: 'build',
          status: 'dispatched',
        }),
      );

      // Agent active jobs should be incremented
      expect(registry.get('agent-1')!.activeJobs).toBe(1);

      // Metrics
      expect(metrics.incJobsDispatched).toHaveBeenCalledWith('dispatched');
    });

    it('dispatches a pinned job only to its pinned agent', async () => {
      registry.register('a1', mockWs(), ['role:web']);
      registry.register('a2', mockWs(), ['role:web']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(
        makeJobInput({ runsOnLabels: ['role:web'], pinnedAgentId: 'a2' }),
      );

      expect(result.status).toBe('dispatched');
      if (result.status === 'dispatched') expect(result.agentId).toBe('a2');
      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(onDispatch).toHaveBeenCalledWith(
        'a2',
        expect.objectContaining({ pinnedAgentId: 'a2' }),
      );
      expect(registry.get('a2')!.activeJobs).toBe(1);
      expect(registry.get('a1')!.activeJobs).toBe(0);
    });

    it('queues a pinned job (with the pin) when the pinned agent is busy', async () => {
      registry.register('a1', mockWs(), ['role:web']); // maxConcurrency 1
      registry.incrementActiveJobs('a1'); // now busy
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(
        makeJobInput({ runsOnLabels: ['role:web'], pinnedAgentId: 'a1' }),
      );

      expect(result.status).toBe('queued');
      expect(onDispatch).not.toHaveBeenCalled();
      // The enqueue carries the pin so the drain only hands it back to a1.
      expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ pinnedAgentId: 'a1' }));
    });

    it('picks the lowest-agentId candidate by default (deterministic)', async () => {
      // Register out of sorted order; default pick must select 'a' regardless.
      registry.register('c', mockWs(), ['role:db']);
      registry.register('a', mockWs(), ['role:db']);
      registry.register('b', mockWs(), ['role:db']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(
        makeJobInput({ runsOnLabels: ['role:db'], jobConfig: { runsOnPick: 'deterministic' } }),
      );

      expect(result.status).toBe('dispatched');
      if (result.status === 'dispatched') expect(result.agentId).toBe('a');
    });

    it('defaults to deterministic when runsOnPick is absent', async () => {
      registry.register('c', mockWs(), ['role:db']);
      registry.register('a', mockWs(), ['role:db']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(
        makeJobInput({ runsOnLabels: ['role:db'], jobConfig: {} }),
      );

      expect(result.status).toBe('dispatched');
      if (result.status === 'dispatched') expect(result.agentId).toBe('a');
    });

    it('pick:any keeps first-available (registration order) selection', async () => {
      registry.register('c', mockWs(), ['role:db']);
      registry.register('a', mockWs(), ['role:db']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(
        makeJobInput({ runsOnLabels: ['role:db'], jobConfig: { runsOnPick: 'any' } }),
      );

      expect(result.status).toBe('dispatched');
      // First registered (insertion order) wins under 'any'.
      if (result.status === 'dispatched') expect(result.agentId).toBe('c');
    });

    it('queues a pinned job when the pinned agent is not connected', async () => {
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(
        makeJobInput({ runsOnLabels: ['role:web'], pinnedAgentId: 'absent' }),
      );

      expect(result.status).toBe('queued');
      expect(queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ pinnedAgentId: 'absent' }),
      );
    });

    it('eagerly drains a pinned job to its agent on availability', async () => {
      registry.register('a1', mockWs(), ['role:web']);
      const pinned = makeQueuedJob({
        id: 'pinned-1',
        runsOnLabels: ['role:web'],
        pinnedAgentId: 'a1',
      });
      const queue = mockQueue({ dequeueJobs: [pinned] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.onAgentAvailable('a1');

      expect(queue.dequeueByPinnedAgent).toHaveBeenCalledWith('a1', ['role:web']);
      expect(onDispatch).toHaveBeenCalledWith('a1', expect.objectContaining({ id: 'pinned-1' }));
    });

    it('resolveOwnedJob returns the runId for an owned job and undefined otherwise', async () => {
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput({ runId: 'run-1' }));
      expect(result.status).toBe('dispatched');
      const jobId = result.status === 'dispatched' ? result.jobId : '';

      expect(dispatcher.resolveOwnedJob('agent-1', jobId)).toEqual({ runId: 'run-1' });
      expect(dispatcher.resolveOwnedJob('agent-1', 'not-a-job')).toBeUndefined();
      expect(dispatcher.resolveOwnedJob('agent-2', jobId)).toBeUndefined();
    });

    it('resolveOwnedJob stops returning a job after it completes', async () => {
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput({ runId: 'run-1' }));
      const jobId = result.status === 'dispatched' ? result.jobId : '';
      expect(dispatcher.resolveOwnedJob('agent-1', jobId)).toEqual({ runId: 'run-1' });

      dispatcher.onJobComplete('agent-1', jobId);
      expect(dispatcher.resolveOwnedJob('agent-1', jobId)).toBeUndefined();
    });

    it('queues when no available agent', async () => {
      // No agents registered
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('queued');
      if (result.status === 'queued') {
        expect(result.jobId).toBe('enqueued-job-id');
      }

      expect(onDispatch).not.toHaveBeenCalled();
      expect(metrics.incJobsDispatched).toHaveBeenCalledWith('queued');
    });

    it('queues when agents exist but none match labels', async () => {
      registry.register('agent-1', mockWs(), ['windows']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput({ runsOnLabels: ['linux'] }));

      expect(result.status).toBe('queued');
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('queues when matching agents are busy', async () => {
      registry.register('agent-1', mockWs(), ['linux']);
      registry.incrementActiveJobs('agent-1'); // Busy
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('queued');
    });

    it('returns rejected when queue is full', async () => {
      const queue = mockQueue({ enqueueFails: true });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBe('queue full');
      }
      expect(metrics.incJobsDispatched).toHaveBeenCalledWith('rejected');
    });

    it('skips agents with excluded labels during direct dispatch', async () => {
      registry.register('agent-excluded', mockWs(), ['linux', 'builder']);
      registry.register('agent-ok', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(
        makeJobInput({ runsOnLabels: ['linux'], excludeLabels: ['builder'] }),
      );

      expect(result.status).toBe('dispatched');
      if (result.status === 'dispatched') {
        expect(result.agentId).toBe('agent-ok');
      }
    });

    it('queues when all matching agents have excluded labels', async () => {
      registry.register('agent-1', mockWs(), ['linux', 'builder']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(
        makeJobInput({ runsOnLabels: ['linux'], excludeLabels: ['builder'] }),
      );

      expect(result.status).toBe('queued');
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('picks an idle agent when one busy and one idle (multiple agents)', async () => {
      registry.register('agent-busy', mockWs(), ['linux']);
      registry.register('agent-idle', mockWs(), ['linux']);
      // Make agent-busy have a job
      registry.incrementActiveJobs('agent-busy');
      // agent-idle has 0 jobs

      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('dispatched');
      if (result.status === 'dispatched') {
        expect(result.agentId).toBe('agent-idle');
      }
    });
  });

  describe('onAgentAvailable', () => {
    it('dispatches exactly one job to idle agent', async () => {
      const jobs = [
        makeQueuedJob({ id: 'job-1', runsOnLabels: ['linux'] }),
        makeQueuedJob({ id: 'job-2', runsOnLabels: ['linux'] }),
      ];
      const queue = mockQueue({ dequeueJobs: jobs });

      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.onAgentAvailable('agent-1');

      // Single-job model: only one job dispatched
      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(onDispatch).toHaveBeenCalledWith('agent-1', expect.objectContaining({ id: 'job-1' }));

      expect(queue.markDispatched).toHaveBeenCalledWith('job-1', 'agent-1');
      expect(registry.get('agent-1')!.activeJobs).toBe(1);
    });

    it('does not dispatch when agent is at max concurrency', async () => {
      const jobs = [makeQueuedJob({ id: 'job-1' })];
      const queue = mockQueue({ dequeueJobs: jobs });

      registry.register('agent-1', mockWs(), ['linux']);
      registry.incrementActiveJobs('agent-1'); // Already at max (default maxConcurrency=1)

      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.onAgentAvailable('agent-1');

      // Agent at capacity -- no dispatch
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('drains queue when agent has partial capacity (maxConcurrency > 1)', async () => {
      const jobs = [makeQueuedJob({ id: 'job-2', runsOnLabels: ['linux'] })];
      const queue = mockQueue({ dequeueJobs: jobs });

      // Register agent with maxConcurrency=2
      registry.register('agent-1', mockWs(), ['linux'], 'linux', 'x64', undefined, 2);
      registry.incrementActiveJobs('agent-1'); // 1 active, capacity for 1 more

      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.onAgentAvailable('agent-1');

      // Agent has capacity -- should dequeue and dispatch
      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(onDispatch).toHaveBeenCalledWith('agent-1', expect.objectContaining({ id: 'job-2' }));
      expect(registry.get('agent-1')!.activeJobs).toBe(2);
    });

    it('does nothing for unknown agent', async () => {
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.onAgentAvailable('nonexistent');

      expect(onDispatch).not.toHaveBeenCalled();
      expect(queue.dequeueForLabels).not.toHaveBeenCalled();
    });

    it('does nothing when queue is empty', async () => {
      const queue = mockQueue({ dequeueJobs: [] });
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.onAgentAvailable('agent-1');

      expect(onDispatch).not.toHaveBeenCalled();
    });
  });

  describe('onAgentDisconnect', () => {
    it('starts recovery timers instead of immediately failing jobs', async () => {
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      // Dispatch one job to the agent (single-job model)
      await dispatcher.dispatch(makeJobInput({ runId: 'run-1' }));
      expect(onDispatch).toHaveBeenCalledTimes(1);

      // Disconnect the agent
      const failedJobIds = await dispatcher.onAgentDisconnect('agent-1');

      // No immediately failed jobs -- recovery timers started instead
      expect(failedJobIds).toEqual([]);
      expect(queue.markFailed).not.toHaveBeenCalled();

      // Job should be marked as recovering in DB
      expect(queue.markRecovering).toHaveBeenCalledTimes(1);

      // Agent should be unregistered from registry
      expect(registry.get('agent-1')).toBeUndefined();

      // Clean up timers
      dispatcher.stopRecoveryTimers();
    });

    it('handles disconnect for agent with no active jobs', async () => {
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.onAgentDisconnect('agent-1');

      expect(queue.markFailed).not.toHaveBeenCalled();
      expect(queue.markRecovering).not.toHaveBeenCalled();
      expect(registry.get('agent-1')).toBeUndefined();
    });

    it('handles disconnect for unknown agent', async () => {
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      // Should not throw
      await dispatcher.onAgentDisconnect('nonexistent');

      expect(queue.markFailed).not.toHaveBeenCalled();
      expect(queue.markRecovering).not.toHaveBeenCalled();
    });
  });

  describe('reboot-pending (workflow host restart)', () => {
    /** In-memory reboot-pending flag store stub matching HostRosterRebootStore. */
    function rebootStore(pending: Set<string>) {
      return {
        isRebootPending: vi.fn(async (agentId: string) => pending.has(agentId)),
        clearRebootPending: vi.fn(async (agentId: string) => {
          pending.delete(agentId);
        }),
      };
    }

    it('onAgentDisconnect completes a started in-flight job as success when reboot-pending', async () => {
      // Realistic order: the restart job dispatches + starts on a non-pending
      // agent, then the step sets the reboot-pending flag, then the box reboots
      // (disconnect). So the flag is added AFTER dispatch+start.
      const pending = new Set<string>();
      const rosterStore = rebootStore(pending);
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch, rosterStore });

      const result = await dispatcher.dispatch(makeJobInput({ runId: 'run-1' }));
      const jobId = (result as { jobId: string }).jobId;
      dispatcher.markJobStarted(jobId);
      pending.add('agent-1'); // restartHost() set the reboot-pending flag

      const failedJobIds = await dispatcher.onAgentDisconnect('agent-1');

      expect(failedJobIds).toEqual([]);
      // Treated as expected reboot: NO recovery timer, completed as success.
      expect(queue.markRecovering).not.toHaveBeenCalled();
      expect(queue.markFailed).not.toHaveBeenCalled();
      expect(queue.markCompleted).toHaveBeenCalledWith(jobId);
      expect(registry.get('agent-1')).toBeUndefined();
      dispatcher.stopRecoveryTimers();
    });

    it('onAgentDisconnect uses the normal recovery path when NOT reboot-pending', async () => {
      const rosterStore = rebootStore(new Set());
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch, rosterStore });

      await dispatcher.dispatch(makeJobInput({ runId: 'run-1' }));
      await dispatcher.onAgentDisconnect('agent-1');

      // Standard path: recovery timer started, no success-completion.
      expect(queue.markRecovering).toHaveBeenCalledTimes(1);
      expect(queue.markCompleted).not.toHaveBeenCalled();
      dispatcher.stopRecoveryTimers();
    });

    it('dispatch() queues a pinned job (does not dispatch) when the agent is reboot-pending', async () => {
      const pending = new Set<string>(['agent-1']);
      const rosterStore = rebootStore(pending);
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch, rosterStore });

      // A pinned post-restart job arriving via the direct-dispatch path (needs
      // satisfied) must be held, not dispatched into the about-to-reboot box.
      const result = await dispatcher.dispatch(
        makeJobInput({ runId: 'run-1', pinnedAgentId: 'agent-1' }),
      );

      expect(result.status).toBe('queued');
      expect(onDispatch).not.toHaveBeenCalled();
      expect(queue.enqueue).toHaveBeenCalled();
    });

    it('dispatch() queues a label-routed job (does not dispatch) when the only matching agent is reboot-pending', async () => {
      // A `runsOn: 'kici:host:<id>'` post-restart job is label-routed (no
      // pinnedAgentId); when its only matching host is reboot-pending it must be
      // held, not sent into the about-to-reboot box.
      const pending = new Set<string>(['host-1']);
      const rosterStore = rebootStore(pending);
      const queue = mockQueue();
      registry.register('host-1', mockWs(), ['kici:host:restart-box']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch, rosterStore });

      const result = await dispatcher.dispatch(
        makeJobInput({ runId: 'run-1', runsOnLabels: ['kici:host:restart-box'] }),
      );

      expect(result.status).not.toBe('dispatched');
      expect(onDispatch).not.toHaveBeenCalled();
      expect(queue.enqueue).toHaveBeenCalled();
    });

    it('dispatch() routes a label-routed job normally when the agent is NOT reboot-pending', async () => {
      const rosterStore = rebootStore(new Set());
      const queue = mockQueue();
      registry.register('host-1', mockWs(), ['kici:host:restart-box']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch, rosterStore });

      const result = await dispatcher.dispatch(
        makeJobInput({ runId: 'run-1', runsOnLabels: ['kici:host:restart-box'] }),
      );

      expect(result.status).toBe('dispatched');
      expect(onDispatch).toHaveBeenCalledTimes(1);
    });

    it('onAgentAvailable holds the pinned drain while reboot-pending', async () => {
      const pending = new Set<string>(['agent-1']);
      const rosterStore = rebootStore(pending);
      const jobs = [makeQueuedJob({ id: 'verify-1', pinnedAgentId: 'agent-1' })];
      const queue = mockQueue({ dequeueJobs: jobs });
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch, rosterStore });

      await dispatcher.onAgentAvailable('agent-1');

      // Reboot-pending ⇒ held, not dispatched into the about-to-reboot box.
      expect(onDispatch).not.toHaveBeenCalled();
      expect(queue.dequeueByPinnedAgent).not.toHaveBeenCalled();
    });

    it('releaseRebootPending clears the flag so the next drain dispatches the held job', async () => {
      const pending = new Set<string>(['agent-1']);
      const rosterStore = rebootStore(pending);
      const jobs = [makeQueuedJob({ id: 'verify-1', pinnedAgentId: 'agent-1' })];
      const queue = mockQueue({ dequeueJobs: jobs });
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch, rosterStore });

      // The reconnect path: clear first, then drain.
      await dispatcher.releaseRebootPending('agent-1');
      expect(rosterStore.clearRebootPending).toHaveBeenCalledWith('agent-1');

      await dispatcher.onAgentAvailable('agent-1');

      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(onDispatch).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ id: 'verify-1' }),
      );
    });

    it('is inert when no rosterStore is injected', async () => {
      const jobs = [makeQueuedJob({ id: 'verify-1', pinnedAgentId: 'agent-1' })];
      const queue = mockQueue({ dequeueJobs: jobs });
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.releaseRebootPending('agent-1'); // no-op, no throw
      await dispatcher.onAgentAvailable('agent-1');

      // No gate ⇒ pinned job dispatches normally.
      expect(onDispatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('onJobComplete', () => {
    it('decrements active jobs and stops tracking', async () => {
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      // Dispatch a job
      const result = await dispatcher.dispatch(makeJobInput());
      expect(result.status).toBe('dispatched');
      expect(registry.get('agent-1')!.activeJobs).toBe(1);

      // Complete the job
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;
      dispatcher.onJobComplete('agent-1', jobId);

      expect(registry.get('agent-1')!.activeJobs).toBe(0);
    });
  });

  describe('dispatchBoundJob', () => {
    it('claims and dispatches the bound job to the registered agent', async () => {
      registry.register('scaler-firecracker-1', mockWs(), ['linux', 'firecracker']);
      const boundJob = makeQueuedJob({ id: 'bound-1', runsOnLabels: ['firecracker'] });
      const queue = mockQueue({ dequeueJobs: [boundJob] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const dispatched = await dispatcher.dispatchBoundJob('scaler-firecracker-1', 'bound-1');

      expect(dispatched).toBe(true);
      expect(queue.dequeueById).toHaveBeenCalledWith(
        'bound-1',
        expect.arrayContaining(['linux']),
        [],
      );
      expect(queue.markDispatched).toHaveBeenCalledWith('bound-1', 'scaler-firecracker-1');
      expect(onDispatch).toHaveBeenCalledWith('scaler-firecracker-1', boundJob);
      expect(registry.get('scaler-firecracker-1')!.activeJobs).toBe(1);
      expect(metrics.incJobsDispatched).toHaveBeenCalledWith('dispatched');
    });

    it('returns false when the bound job is no longer in the queue', async () => {
      registry.register('scaler-firecracker-1', mockWs(), ['linux', 'firecracker']);
      const queue = mockQueue({ dequeueJobs: [] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const dispatched = await dispatcher.dispatchBoundJob('scaler-firecracker-1', 'bound-1');

      expect(dispatched).toBe(false);
      expect(queue.markDispatched).not.toHaveBeenCalled();
      expect(onDispatch).not.toHaveBeenCalled();
      expect(registry.get('scaler-firecracker-1')!.activeJobs).toBe(0);
    });

    it('returns false when the agent is not registered', async () => {
      const boundJob = makeQueuedJob({ id: 'bound-1' });
      const queue = mockQueue({ dequeueJobs: [boundJob] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const dispatched = await dispatcher.dispatchBoundJob('ghost-agent', 'bound-1');

      expect(dispatched).toBe(false);
      expect(queue.dequeueById).not.toHaveBeenCalled();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('returns false when the agent is at max concurrency', async () => {
      registry.register('scaler-firecracker-1', mockWs(), ['linux'], 1);
      registry.incrementActiveJobs('scaler-firecracker-1');
      const boundJob = makeQueuedJob({ id: 'bound-1' });
      const queue = mockQueue({ dequeueJobs: [boundJob] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const dispatched = await dispatcher.dispatchBoundJob('scaler-firecracker-1', 'bound-1');

      expect(dispatched).toBe(false);
      expect(queue.dequeueById).not.toHaveBeenCalled();
    });
  });

  describe('onNoMatchingAgent hook', () => {
    it('enqueues job when onNoMatchingAgent returns spawning', async () => {
      const queue = mockQueue();
      const onNoMatchingAgent = vi
        .fn()
        .mockResolvedValue({ action: 'spawning', backendType: 'docker' });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('queued');
      // The dispatcher enqueues first (so it has a stable jobId for the
      // scaler to bind), then calls onNoMatchingAgent with that queue jobId
      // plus the run id. The jobId powers the eager-dispatch fix for the
      // scaler-managed agent idle-shutdown race; the runId lets a spawn that
      // fails before WS registration be attributed back to its run.
      const queuedJobId = (result as { status: 'queued'; jobId: string }).jobId;
      expect(onNoMatchingAgent).toHaveBeenCalledWith(
        ['linux'],
        queuedJobId,
        'run-1',
        [],
        undefined,
      );
      expect(metrics.incJobsDispatched).toHaveBeenCalledWith('queued');
    });

    it('passes job resources to onNoMatchingAgent', async () => {
      const queue = mockQueue();
      const onNoMatchingAgent = vi
        .fn()
        .mockResolvedValue({ action: 'spawning', backendType: 'docker' });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      const resources = {
        requests: { cpus: 1, memory: '512m' },
        limits: { cpus: 2, memory: '2g' },
      };
      const result = await dispatcher.dispatch(makeJobInput({ resources }));

      expect(result.status).toBe('queued');
      const queuedJobId = (result as { status: 'queued'; jobId: string }).jobId;
      expect(onNoMatchingAgent).toHaveBeenCalledWith(
        ['linux'],
        queuedJobId,
        'run-1',
        [],
        resources,
      );
    });

    it('passes the queued job runId to onNoMatchingAgent as the third argument', async () => {
      const queue = mockQueue();
      const onNoMatchingAgent = vi
        .fn()
        .mockResolvedValue({ action: 'spawning', backendType: 'docker' });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      // No registered agent matches these labels, so the no-match path is taken.
      const result = await dispatcher.dispatch(
        makeJobInput({ runId: 'run-attribution-1', runsOnLabels: ['linux'] }),
      );

      expect(result.status).toBe('queued');
      const queuedJobId = (result as { status: 'queued'; jobId: string }).jobId;
      expect(onNoMatchingAgent).toHaveBeenCalledWith(
        ['linux'],
        queuedJobId,
        'run-attribution-1',
        [],
        undefined,
      );
    });

    it('queues job with queued-no-backend when onNoMatchingAgent returns no-backend and no agent registered', async () => {
      const queue = mockQueue();
      const onNoMatchingAgent = vi
        .fn()
        .mockResolvedValue({ action: 'no-backend', labels: ['linux'] });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('queued-no-backend');
      expect(metrics.incJobsDispatched).toHaveBeenCalledWith('queued');
      expect(queue.enqueue).toHaveBeenCalled();
    });

    it('queues job when onNoMatchingAgent returns no-backend but a busy agent has matching labels', async () => {
      // Register an agent with matching labels but at full capacity
      registry.register('agent-busy', mockWs(), ['linux'], 1);
      registry.incrementActiveJobs('agent-busy');

      const queue = mockQueue();
      const onNoMatchingAgent = vi
        .fn()
        .mockResolvedValue({ action: 'no-backend', labels: ['linux'] });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('queued');
      expect(metrics.incJobsDispatched).toHaveBeenCalledWith('queued');
      expect(queue.enqueue).toHaveBeenCalled();
    });

    it('enqueues job when onNoMatchingAgent returns at-capacity', async () => {
      const queue = mockQueue();
      const onNoMatchingAgent = vi.fn().mockResolvedValue({ action: 'at-capacity' });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('queued');
      expect(metrics.incJobsDispatched).toHaveBeenCalledWith('queued');
    });

    it('enqueues job when onNoMatchingAgent returns failed', async () => {
      const queue = mockQueue();
      const onNoMatchingAgent = vi
        .fn()
        .mockResolvedValue({ action: 'failed', error: 'spawn error' });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('queued');
      expect(metrics.incJobsDispatched).toHaveBeenCalledWith('queued');
    });

    it('falls through to enqueue when onNoMatchingAgent is not configured', async () => {
      const queue = mockQueue();
      // No onNoMatchingAgent provided -- backward compatible
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('queued');
    });

    it('does not call onNoMatchingAgent when agent is available', async () => {
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const onNoMatchingAgent = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('dispatched');
      expect(onNoMatchingAgent).not.toHaveBeenCalled();
    });
  });

  describe('onDispatch callback verification', () => {
    it('callback receives correct agentId and full job data', async () => {
      registry.register('agent-42', mockWs(), ['linux', 'docker']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.dispatch(
        makeJobInput({
          runId: 'run-99',
          workflowName: 'deploy',
          jobName: 'build-image',
          runsOnLabels: ['linux', 'docker'],
          sha: 'deadbeef',
          deliveryId: 'del-99',
          provider: 'github',
          providerContext: { installationId: 123 },
        }),
      );

      expect(onDispatch).toHaveBeenCalledTimes(1);
      const [agentId, job] = onDispatch.mock.calls[0] as [string, QueuedJob];

      expect(agentId).toBe('agent-42');
      expect(job.runId).toBe('run-99');
      expect(job.workflowName).toBe('deploy');
      expect(job.jobName).toBe('build-image');
      expect(job.runsOnLabels).toEqual(['linux', 'docker']);
      expect(job.sha).toBe('deadbeef');
      expect(job.deliveryId).toBe('del-99');
      expect(job.provider).toBe('github');
      expect(job.providerContext).toEqual({ installationId: 123 });
      expect(job.status).toBe('dispatched');
    });
  });

  describe('isJobOwnedByAgent', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns true for active job', async () => {
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());
      expect(result.status).toBe('dispatched');

      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;
      expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(true);
    });

    it('returns true for completed job in grace window', async () => {
      vi.useFakeTimers();
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      dispatcher.onJobComplete('agent-1', jobId);

      // Still in grace window
      expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(true);
    });

    it('returns false for completed job after grace window expires', async () => {
      vi.useFakeTimers();
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      dispatcher.onJobComplete('agent-1', jobId);

      // Advance past grace window (30s)
      vi.advanceTimersByTime(31_000);

      expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(false);
    });

    it('returns false for unknown job', () => {
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      expect(dispatcher.isJobOwnedByAgent('agent-1', 'unknown-job')).toBe(false);
    });

    it('returns false for job owned by different agent', async () => {
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      expect(dispatcher.isJobOwnedByAgent('agent-2', jobId)).toBe(false);
    });
  });

  describe('grace window cleanup', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('expired entries are cleaned by grace cleanup interval', async () => {
      vi.useFakeTimers();
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      dispatcher.onJobComplete('agent-1', jobId);
      dispatcher.startGraceCleanup();

      // Still in grace window at 29s
      vi.advanceTimersByTime(29_000);
      expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(true);

      // Advance past grace window and let cleanup run
      vi.advanceTimersByTime(2_000);
      expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(false);

      dispatcher.stopGraceCleanup();
    });

    it('onAgentDisconnect cleans up completedJobs for the agent', async () => {
      vi.useFakeTimers();
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      dispatcher.onJobComplete('agent-1', jobId);
      expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(true);

      // Re-register agent since onJobComplete unregistered it via registry
      registry.register('agent-1', mockWs(), ['linux']);
      await dispatcher.onAgentDisconnect('agent-1');

      expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(false);
    });
  });

  describe('recovery timers', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('claimRecovery cancels timer and returns true', async () => {
      vi.useFakeTimers();
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      // Disconnect starts recovery (now also persists deadline + agentId
      // so a replacement coord can resume the sweep).
      await dispatcher.onAgentDisconnect('agent-1');
      expect(queue.markRecovering).toHaveBeenCalledWith(jobId, expect.any(Date), 'agent-1');

      // Claim recovery before timer fires
      const claimed = dispatcher.claimRecovery(jobId, 'agent-1');
      expect(claimed).toBe(true);

      // Advance past grace period -- timer should NOT fire
      vi.advanceTimersByTime(200_000);
      await vi.runAllTimersAsync();
      expect(queue.markFailedIfRecovering).not.toHaveBeenCalled();
    });

    it('claimRecovery returns false for wrong agent', async () => {
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      await dispatcher.onAgentDisconnect('agent-1');

      // Wrong agent trying to claim
      const claimed = dispatcher.claimRecovery(jobId, 'agent-2');
      expect(claimed).toBe(false);

      dispatcher.stopRecoveryTimers();
    });

    it('recovery timer fires and fails job after grace period', async () => {
      vi.useFakeTimers();
      const onJobFailedPermanently = vi.fn();
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onJobFailedPermanently,
      });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      await dispatcher.onAgentDisconnect('agent-1');

      // Advance past default grace period (2x 60s = 120s)
      await vi.advanceTimersByTimeAsync(120_000);

      expect(queue.markFailedIfRecovering).toHaveBeenCalledWith(
        jobId,
        'Job failed: agent disconnected and did not reconnect within the recovery window',
      );
      expect(onJobFailedPermanently).toHaveBeenCalledWith(
        'agent-1',
        jobId,
        'run-1',
        expect.stringContaining('recovery window'),
      );
    });

    it('onRecoveryStarted callback fires on disconnect', async () => {
      const queue = mockQueue();
      const onRecoveryStarted = vi.fn();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onRecoveryStarted,
      });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      await dispatcher.onAgentDisconnect('agent-1');

      expect(onRecoveryStarted).toHaveBeenCalledWith('agent-1', jobId);

      dispatcher.stopRecoveryTimers();
    });

    it('getRecoveringJobsForAgent returns correct job IDs', async () => {
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      // Dispatch 1 job (single-job model)
      const result1 = await dispatcher.dispatch(makeJobInput({ runId: 'run-1' }));
      const jobId1 = (result1 as { status: 'dispatched'; jobId: string }).jobId;

      // Disconnect starts recovery
      await dispatcher.onAgentDisconnect('agent-1');

      const recovering = dispatcher.getRecoveringJobsForAgent('agent-1');
      expect(recovering).toHaveLength(1);
      expect(recovering).toContain(jobId1);

      // Different agent has no recovering jobs
      expect(dispatcher.getRecoveringJobsForAgent('agent-2')).toEqual([]);

      dispatcher.stopRecoveryTimers();
    });

    it('isJobOwnedByAgent returns true for recovering jobs', async () => {
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      await dispatcher.onAgentDisconnect('agent-1');

      // Job is recovering -- still owned by agent-1
      expect(dispatcher.isJobOwnedByAgent('agent-1', jobId)).toBe(true);
      // Not owned by different agent
      expect(dispatcher.isJobOwnedByAgent('agent-2', jobId)).toBe(false);

      dispatcher.stopRecoveryTimers();
    });

    it('grace period is 2x maxReconnectDelayMs', async () => {
      vi.useFakeTimers();
      const onJobFailedPermanently = vi.fn();
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        maxReconnectDelayMs: 30_000,
        onJobFailedPermanently,
      });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      await dispatcher.onAgentDisconnect('agent-1');

      // At 59,999ms -- job should still be recovering
      await vi.advanceTimersByTimeAsync(59_999);
      expect(queue.markFailedIfRecovering).not.toHaveBeenCalled();

      // At 60,000ms (2x 30s) -- timer fires
      await vi.advanceTimersByTimeAsync(1);
      expect(queue.markFailedIfRecovering).toHaveBeenCalledWith(
        jobId,
        'Job failed: agent disconnected and did not reconnect within the recovery window',
      );
      expect(onJobFailedPermanently).toHaveBeenCalledWith(
        'agent-1',
        jobId,
        'run-1',
        expect.stringContaining('recovery window'),
      );
    });

    it('getRecoveryInfo returns info for recovering job', async () => {
      vi.useFakeTimers();
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      await dispatcher.onAgentDisconnect('agent-1');

      const info = dispatcher.getRecoveryInfo(jobId);
      expect(info).not.toBeNull();
      expect(info!.agentId).toBe('agent-1');
      expect(info!.disconnectedAt).toBeGreaterThan(0);

      // Unknown job returns null
      expect(dispatcher.getRecoveryInfo('unknown-job')).toBeNull();

      dispatcher.stopRecoveryTimers();
    });

    it('recovery timer catches DB errors instead of crashing (unhandled rejection)', async () => {
      vi.useFakeTimers();
      const queue = mockQueue();
      // Make markFailedIfRecovering throw a DB error
      (queue.markFailedIfRecovering as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('connection refused'),
      );
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
      });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;

      await dispatcher.onAgentDisconnect('agent-1');

      // Advance past grace period -- timer fires, DB call fails, should NOT throw
      await vi.advanceTimersByTimeAsync(120_000);

      // markFailedIfRecovering was called (and failed), but no unhandled rejection
      expect(queue.markFailedIfRecovering).toHaveBeenCalledWith(jobId, expect.any(String));
    });

    it('stopRecoveryTimers clears all timers', async () => {
      vi.useFakeTimers();
      const onJobFailedPermanently = vi.fn();
      const queue = mockQueue();
      registry.register('agent-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onJobFailedPermanently,
      });

      await dispatcher.dispatch(makeJobInput());
      await dispatcher.onAgentDisconnect('agent-1');

      // Stop all timers
      dispatcher.stopRecoveryTimers();

      // Advance past grace period -- timer should NOT fire
      await vi.advanceTimersByTimeAsync(200_000);
      expect(queue.markFailedIfRecovering).not.toHaveBeenCalled();
      expect(onJobFailedPermanently).not.toHaveBeenCalled();
    });

    it('startRecoveryTimer creates timer for startup recovery', async () => {
      vi.useFakeTimers();
      const onJobFailedPermanently = vi.fn();
      const onRecoveryStarted = vi.fn();
      const queue = mockQueue();
      const dispatcher = new Dispatcher({
        registry,
        queue: queue,
        metrics,
        onDispatch,
        maxReconnectDelayMs: 10_000,
        onJobFailedPermanently,
        onRecoveryStarted,
      });

      await dispatcher.startRecoveryTimer('job-42', 'agent-1', 'run-42');

      // markRecovering is now called with the persisted deadline + agentId
      expect(queue.markRecovering).toHaveBeenCalledWith(
        'job-42',
        expect.any(Date),
        expect.any(String),
      );
      expect(onRecoveryStarted).toHaveBeenCalledWith('agent-1', 'job-42');

      // Job should be owned by agent
      expect(dispatcher.isJobOwnedByAgent('agent-1', 'job-42')).toBe(true);

      // Advance past grace period (2x 10s = 20s)
      await vi.advanceTimersByTimeAsync(20_000);

      expect(queue.markFailedIfRecovering).toHaveBeenCalledWith(
        'job-42',
        'Job failed: agent disconnected and did not reconnect within the recovery window',
      );
      expect(onJobFailedPermanently).toHaveBeenCalledWith(
        'agent-1',
        'job-42',
        'run-42',
        expect.stringContaining('recovery window'),
      );
    });
  });

  describe('drain race hardening', () => {
    it('concurrent onAgentAvailable calls dispatch at most maxConcurrency jobs', async () => {
      const registry = new AgentRegistry();
      registry.register('agent-1', mockWs(), ['linux']); // maxConcurrency 1

      let dequeues = 0;
      const queue = {
        ...mockQueue(),
        // Async gap widens the check-then-claim window: both racers reach
        // the dequeue before either would have incremented under the old code.
        dequeueForLabels: vi.fn(async () => {
          dequeues++;
          await new Promise((r) => setTimeout(r, 10));
          return makeQueuedJob({ id: `job-${dequeues}` });
        }),
        markDispatched: vi.fn(async () => {}),
        getDepth: vi.fn(async () => 0),
      } as unknown as JobQueue;

      const onDispatch = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch,
      });

      await Promise.all([
        dispatcher.onAgentAvailable('agent-1'),
        dispatcher.onAgentAvailable('agent-1'),
      ]);

      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(registry.get('agent-1')?.activeJobs).toBe(1);
    });
  });

  describe('onJobRejected', () => {
    it('undoes accounting, requeues, and redispatches to another agent', async () => {
      const registry = new AgentRegistry();
      // 'idle-agent' sorts below 'zzz-rejecter', so deterministic selection (the
      // default) lands the requeued job on the non-rejecting agent.
      registry.register('idle-agent', mockWs(), ['linux']);
      registry.register('zzz-rejecter', mockWs(), ['linux']);

      const requeue = vi.fn(async () => 1);
      const fullJob = makeQueuedJob({ id: 'job-1', status: 'pending' });
      const queue = {
        ...mockQueue(),
        requeue,
        getFullJobById: vi.fn(async () => fullJob),
        dequeueById: vi.fn(async () => fullJob),
        markDispatched: vi.fn(async () => {}),
        getDepth: vi.fn(async () => 0),
      } as unknown as JobQueue;

      const onDispatch = vi.fn();
      const dispatcher = new Dispatcher({ registry, queue, metrics: mockMetrics(), onDispatch });

      // Simulate the phantom dispatch: job-1 tracked to the rejecting agent.
      registry.incrementActiveJobs('zzz-rejecter');
      dispatcher.restoreJobForAgent('zzz-rejecter', 'job-1');

      await dispatcher.onJobRejected('zzz-rejecter', 'job-1', 'busy');

      expect(requeue).toHaveBeenCalledWith('job-1');
      expect(registry.get('zzz-rejecter')?.activeJobs).toBe(0);
      // Redispatched to the idle agent via dispatchBoundJob:
      expect(onDispatch).toHaveBeenCalledWith(
        'idle-agent',
        expect.objectContaining({ id: 'job-1' }),
      );
    });

    it('ignores a reject for a job not tracked to the agent', async () => {
      const registry = new AgentRegistry();
      registry.register('a1', mockWs(), ['linux']);
      const requeue = vi.fn();
      const queue = { ...mockQueue(), requeue } as unknown as JobQueue;
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
      });
      await dispatcher.onJobRejected('a1', 'unknown-job', 'busy');
      expect(requeue).not.toHaveBeenCalled();
    });

    it('fails the job permanently when attempts are exhausted', async () => {
      const registry = new AgentRegistry();
      registry.register('a1', mockWs(), ['linux']);
      const markFailed = vi.fn(async () => {});
      const queue = {
        ...mockQueue(),
        requeue: vi.fn(async () => 5), // MAX_DISPATCH_ATTEMPTS reached
        getJobById: vi.fn(async () => ({ id: 'job-1', runId: 'run-1', status: 'pending' })),
        markFailed,
        getDepth: vi.fn(async () => 0),
      } as unknown as JobQueue;
      const onJobFailedPermanently = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        onJobFailedPermanently,
      });
      registry.incrementActiveJobs('a1');
      dispatcher.restoreJobForAgent('a1', 'job-1');

      await dispatcher.onJobRejected('a1', 'job-1', 'busy');

      expect(markFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('attempts'));
      expect(onJobFailedPermanently).toHaveBeenCalledWith(
        'a1',
        'job-1',
        'run-1',
        expect.stringContaining('attempts'),
      );
    });

    it('consults the scaler when no agent can take the requeued job', async () => {
      const registry = new AgentRegistry();
      registry.register('busy-agent', mockWs(), ['linux']); // only agent; will be at capacity
      const fullJob = makeQueuedJob({ id: 'job-1', status: 'pending', runsOnLabels: ['linux'] });
      const queue = {
        ...mockQueue(),
        requeue: vi.fn(async () => 1),
        getFullJobById: vi.fn(async () => fullJob),
        getDepth: vi.fn(async () => 0),
      } as unknown as JobQueue;
      const onNoMatchingAgent = vi.fn(async () => ({
        action: 'spawning',
        backendType: 'container',
      }));
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        onNoMatchingAgent: onNoMatchingAgent as never,
      });
      registry.incrementActiveJobs('busy-agent'); // the real job keeps the agent busy
      registry.incrementActiveJobs('busy-agent'); // phantom
      dispatcher.restoreJobForAgent('busy-agent', 'job-1');

      await dispatcher.onJobRejected('busy-agent', 'job-1', 'busy');

      expect(onNoMatchingAgent).toHaveBeenCalledWith(['linux'], 'job-1', 'run-1', [], undefined);
    });
  });

  describe('scaler-managed disconnect triage', () => {
    function setupScalerAgent(queueOverrides: Record<string, unknown>) {
      const registry = new AgentRegistry();
      registry.register('sc-1', mockWs(), ['linux'], 'linux', 'x64', undefined, 1, {
        scalerManaged: true,
      });
      const queue = {
        ...mockQueue(),
        getDepth: vi.fn(async () => 0),
        ...queueOverrides,
      } as unknown as JobQueue;
      return { registry, queue };
    }

    it('requeues a never-started job instead of starting recovery', async () => {
      const requeue = vi.fn(async () => 1);
      const markRecovering = vi.fn();
      const { registry, queue } = setupScalerAgent({
        requeue,
        markRecovering,
        // The dispatch path that tracks a job WITHOUT marking it started:
        // dispatchBoundJob with a stubbed dequeueById models a dispatch that
        // never produced a `job.status: running`.
        dequeueById: vi.fn(async () => makeQueuedJob({ id: 'job-1' })),
        markDispatched: vi.fn(async () => {}),
        getJobById: vi.fn(async () => ({ id: 'job-1', runId: 'run-1', status: 'dispatched' })),
        getFullJobById: vi.fn(async () => null), // redispatch finds nothing further to do
      });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
      });
      await dispatcher.dispatchBoundJob('sc-1', 'job-1'); // tracked, NOT started

      const failed = await dispatcher.onAgentDisconnect('sc-1');

      expect(markRecovering).not.toHaveBeenCalled();
      expect(requeue).toHaveBeenCalledWith('job-1');
      expect(failed).toEqual([]); // requeued, not failed
    });

    it('fails fast a started job on a scaler-managed agent', async () => {
      const markFailed = vi.fn(async () => {});
      const markRecovering = vi.fn();
      const { registry, queue } = setupScalerAgent({
        markFailed,
        markRecovering,
        getJobById: vi.fn(async () => ({ id: 'job-2', runId: 'run-2', status: 'dispatched' })),
      });
      const onJobFailedPermanently = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        onJobFailedPermanently,
      });
      registry.incrementActiveJobs('sc-1');
      dispatcher.restoreJobForAgent('sc-1', 'job-2');
      dispatcher.markJobStarted('job-2');

      const failed = await dispatcher.onAgentDisconnect('sc-1');

      expect(markRecovering).not.toHaveBeenCalled();
      expect(markFailed).toHaveBeenCalledWith('job-2', expect.stringContaining('mid-execution'));
      expect(onJobFailedPermanently).toHaveBeenCalledWith(
        'sc-1',
        'job-2',
        'run-2',
        expect.stringContaining('mid-execution'),
      );
      expect(failed).toEqual(['job-2']);
    });

    it('static agents keep the recovery window', async () => {
      const registry = new AgentRegistry();
      registry.register('static-1', mockWs(), ['linux']); // scalerManaged: false
      const markRecovering = vi.fn(async () => {});
      const queue = {
        ...mockQueue(),
        markRecovering,
        getJobById: vi.fn(async () => ({ id: 'job-3', runId: 'run-3', status: 'dispatched' })),
        getDepth: vi.fn(async () => 0),
      } as unknown as JobQueue;
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
      });
      registry.incrementActiveJobs('static-1');
      dispatcher.restoreJobForAgent('static-1', 'job-3');

      await dispatcher.onAgentDisconnect('static-1');

      expect(markRecovering).toHaveBeenCalled();
      dispatcher.stopRecoveryTimers();
    });
  });

  describe('dispatch ack deadline', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function dispatchedJobId(result: { status: string }): string {
      expect(result.status).toBe('dispatched');
      return (result as { status: 'dispatched'; jobId: string }).jobId;
    }

    it('requeues the job and fires onAckTimeout when no ack arrives', async () => {
      vi.useFakeTimers();
      registry.register('a1', mockWs(), ['linux']);
      const queue = mockQueue();
      const onAckTimeout = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        getAckTimeoutMs: async () => 5_000,
        onAckTimeout,
      });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = dispatchedJobId(result);

      await vi.advanceTimersByTimeAsync(5_001);

      expect(queue.requeue).toHaveBeenCalledWith(jobId);
      expect(onAckTimeout).toHaveBeenCalledWith('a1', jobId, 'run-1');
    });

    it('unregisters the timed-out agent before requeueing so the redispatch cannot return to it', async () => {
      vi.useFakeTimers();
      registry.register('a1', mockWs(), ['linux']);
      registry.register('a2', mockWs(), ['linux']);
      const queue = mockQueue();
      const onDispatch = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch,
        getAckTimeoutMs: async () => 5_000,
        onAckTimeout: vi.fn(),
      });

      const jobId = dispatchedJobId(await dispatcher.dispatch(makeJobInput()));
      // The requeued job is pending and re-dequeuable for the healthy agent.
      const pendingJob = makeQueuedJob({ id: jobId, status: 'pending' });
      (queue.getFullJobById as ReturnType<typeof vi.fn>).mockResolvedValue(pendingJob);
      (queue.dequeueById as ReturnType<typeof vi.fn>).mockResolvedValue(pendingJob);

      onDispatch.mockClear();
      await vi.advanceTimersByTimeAsync(5_001);

      // The timed-out agent is gone from the registry...
      expect(registry.get('a1')).toBeUndefined();
      // ...and the redispatch went to the healthy agent, never back to a1.
      const redispatchTargets = onDispatch.mock.calls.map((c) => c[0]);
      expect(redispatchTargets).toContain('a2');
      expect(redispatchTargets).not.toContain('a1');
    });

    it('an ack that beats the deadline arming is honored (no spurious requeue)', async () => {
      // getAckTimeoutMs blocks on a gate, so the agent's ack can arrive between
      // the dispatch send and the pending-ack entry being armed — the real
      // race the earlyAcks map closes.
      registry.register('a1', mockWs(), ['linux']);
      const queue = mockQueue();
      const onAckTimeout = vi.fn();
      let releaseTimeout!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseTimeout = resolve;
      });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        getAckTimeoutMs: async () => {
          await gate; // block arming until the test releases it
          return 5_000;
        },
        onAckTimeout,
      });

      // dispatch() blocks inside armAckDeadline -> getAckTimeoutMs (gated).
      const dispatchPromise = dispatcher.dispatch(makeJobInput());
      await new Promise((r) => setTimeout(r, 5));

      const insertMock = queue.insertDispatched as ReturnType<typeof vi.fn>;
      const jobId = (await insertMock.mock.results[0].value) as string;

      // Ack arrives before arming completes; recorded as an early ack.
      dispatcher.onJobAcked('a1', jobId);
      // Release the gate so armAckDeadline runs and consumes the early ack.
      releaseTimeout();
      await dispatchPromise;
      await new Promise((r) => setTimeout(r, 10));

      expect(queue.requeue).not.toHaveBeenCalled();
      expect(onAckTimeout).not.toHaveBeenCalled();
    });

    it('onJobAcked resolves the deadline — no requeue, no onAckTimeout', async () => {
      vi.useFakeTimers();
      registry.register('a1', mockWs(), ['linux']);
      const queue = mockQueue();
      const onAckTimeout = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        getAckTimeoutMs: async () => 5_000,
        onAckTimeout,
      });

      const jobId = dispatchedJobId(await dispatcher.dispatch(makeJobInput()));
      dispatcher.onJobAcked('a1', jobId);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(queue.requeue).not.toHaveBeenCalled();
      expect(onAckTimeout).not.toHaveBeenCalled();
      expect(queue.clearAckDeadline).toHaveBeenCalledWith(jobId);
    });

    it('markJobStarted resolves the deadline (running doubles as ack)', async () => {
      vi.useFakeTimers();
      registry.register('a1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        getAckTimeoutMs: async () => 5_000,
      });

      const jobId = dispatchedJobId(await dispatcher.dispatch(makeJobInput()));
      dispatcher.markJobStarted(jobId);

      await vi.advanceTimersByTimeAsync(10_000);

      expect(queue.requeue).not.toHaveBeenCalled();
    });

    it('onJobRejected resolves the deadline (exactly one requeue from the reject)', async () => {
      vi.useFakeTimers();
      registry.register('a1', mockWs(), ['linux']);
      const queue = mockQueue();
      const onAckTimeout = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        getAckTimeoutMs: async () => 5_000,
        onAckTimeout,
      });

      const jobId = dispatchedJobId(await dispatcher.dispatch(makeJobInput()));
      await dispatcher.onJobRejected('a1', jobId, 'busy');

      await vi.advanceTimersByTimeAsync(10_000);

      expect(queue.requeue).toHaveBeenCalledTimes(1);
      expect(onAckTimeout).not.toHaveBeenCalled();
    });

    it('disconnect before the deadline clears the pending ack without double-requeue', async () => {
      vi.useFakeTimers();
      registry.register('a1', mockWs(), ['linux'], 'linux', 'x64', undefined, 1, {
        scalerManaged: true,
      });
      const queue = mockQueue();
      const onAckTimeout = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        getAckTimeoutMs: async () => 5_000,
        onAckTimeout,
      });

      dispatchedJobId(await dispatcher.dispatch(makeJobInput()));
      await dispatcher.onAgentDisconnect('a1');

      expect(queue.requeue).toHaveBeenCalledTimes(1); // disconnect triage requeue

      await vi.advanceTimersByTimeAsync(10_000);

      expect(queue.requeue).toHaveBeenCalledTimes(1); // no second requeue from ack expiry
      expect(onAckTimeout).not.toHaveBeenCalled();
    });

    it('ack from a non-owning agent is ignored (deadline still fires)', async () => {
      vi.useFakeTimers();
      registry.register('a1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        getAckTimeoutMs: async () => 5_000,
      });

      const jobId = dispatchedJobId(await dispatcher.dispatch(makeJobInput()));
      dispatcher.onJobAcked('a2', jobId); // wrong agent

      await vi.advanceTimersByTimeAsync(5_001);

      expect(queue.requeue).toHaveBeenCalledWith(jobId);
    });

    it('incident regression: dispatched, never acked, scaler agent disconnects -> requeued and scaler consulted', async () => {
      registry.register('a1', mockWs(), ['linux'], 'linux', 'x64', undefined, 1, {
        scalerManaged: true,
      });
      const queue = mockQueue();
      const pendingJob = makeQueuedJob({ id: 'will-requeue', status: 'pending' });
      (queue.getFullJobById as ReturnType<typeof vi.fn>).mockResolvedValue(pendingJob);
      const onNoMatchingAgent = vi
        .fn()
        .mockResolvedValue({ action: 'spawning' as const, agentId: 'spawned-1' });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        onNoMatchingAgent,
        getAckTimeoutMs: async () => 50_000,
      });

      const result = await dispatcher.dispatch(makeJobInput());
      const jobId = dispatchedJobId(result);
      (queue.getFullJobById as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeQueuedJob({ id: jobId, status: 'pending' }),
      );

      // Simulate the lost dispatch: no ack, no running, then the agent (the
      // only one) disconnects. Triage must requeue and consult the scaler.
      await dispatcher.onAgentDisconnect('a1');

      expect(queue.requeue).toHaveBeenCalledWith(jobId);
      expect(onNoMatchingAgent).toHaveBeenCalled();
      dispatcher.stopRecoveryTimers();
    });
  });

  describe('ack deadline recovery + sweep', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('recoverState re-arms timers from persisted ack deadlines', async () => {
      vi.useFakeTimers();
      const queue = mockQueue();
      (queue.getDispatchedAwaitingAck as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'job-r', runId: 'run-r', agentId: 'a1', deadline: new Date(Date.now() + 3_000) },
      ]);
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
      });

      await dispatcher.recoverState();
      await vi.advanceTimersByTimeAsync(3_100);

      expect(queue.requeue).toHaveBeenCalledWith('job-r');
      dispatcher.stopRecoveryTimers();
    });

    it('sweepExpiredAckDeadlines requeues expired dispatched rows', async () => {
      registry.register('a1', mockWs(), ['linux']);
      const queue = mockQueue();
      (queue.listExpiredAckDeadlines as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'job-s', runId: 'run-s', agentId: 'a1' },
      ]);
      const onAckTimeout = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        onAckTimeout,
      });

      const count = await dispatcher.sweepExpiredAckDeadlines();

      expect(count).toBe(1);
      expect(queue.requeue).toHaveBeenCalledWith('job-s');
      expect(onAckTimeout).toHaveBeenCalledWith('a1', 'job-s', 'run-s');
    });
  });
});
