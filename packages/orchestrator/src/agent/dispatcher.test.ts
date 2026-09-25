import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Dispatcher, containerSpawnFor, type DispatchMetrics } from './dispatcher.js';
import { AgentRegistry, BUSY_HOLD_MAX_MS } from './registry.js';
import type { ScaleResult } from '../scaler/types.js';
import {
  DispatchQueueStatus,
  MAX_DISPATCH_ATTEMPTS,
  type JobQueue,
  type QueuedJob,
  type QueuedJobInput,
} from '../queue/job-queue.js';
import { canonicalizeLabels, JobRejectReason } from '@kici-dev/engine';
import { mockWs } from '../__test-helpers__/mock-ws.js';
import { JobSecretsUnsealError } from '../secrets/job-secret-seal.js';

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
    incScalerRedispatch: vi.fn(),
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
    /** Pending rows returned (oldest-first, capped) by listPending. */
    pendingJobs?: QueuedJob[];
    /** Map of jobId -> { runId, status } for getJobById lookups. */
    jobLookups?: Map<string, { id: string; runId: string; status: string }>;
  } = {},
): JobQueue {
  const {
    depth = 0,
    enqueueFails = false,
    dequeueJobs = [],
    pendingJobs = [],
    jobLookups,
  } = options;
  let dequeueIndex = 0;

  // Track dispatched job IDs to auto-populate getJobById if no explicit map
  const dispatchedJobIds: string[] = [];

  return {
    enqueue: enqueueFails
      ? vi.fn().mockRejectedValue(new Error('queue full'))
      : vi.fn().mockResolvedValue('enqueued-job-id'),
    insertDispatched: vi.fn().mockImplementation(async (input: QueuedJobInput) => {
      const id = input.jobId ?? crypto.randomUUID();
      dispatchedJobIds.push(id);
      return { id, inserted: true };
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
    listPending: vi.fn().mockImplementation(async (limit: number) => pendingJobs.slice(0, limit)),
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
    requeueIfAwaitingAck: vi.fn().mockResolvedValue(1),
    getFullJobById: vi.fn().mockResolvedValue(null),
    // Sealed-secrets back-off: nothing deferred unless a test says so.
    isDeferredUnopenable: vi.fn().mockReturnValue(false),
    deferUnopenable: vi.fn().mockResolvedValue(undefined),
    claimUnopenableById: vi.fn().mockResolvedValue(true),
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

    it('records the selected agent as the durable owner on the direct-dispatch insert', async () => {
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.dispatch(makeJobInput());

      // The row is inserted already-dispatched, so it never reaches
      // markDispatched — the owner has to be written by the insert itself or a
      // cold coordinator can never resolve ownership of this job.
      expect(queue.insertDispatched).toHaveBeenCalledWith(expect.anything(), 'agent-1');
      expect(queue.markDispatched).not.toHaveBeenCalled();
    });

    it('returns duplicate and does NOT dispatch to the agent when the row already exists', async () => {
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      // Model a concurrent reroute: insertDispatched finds the row already present.
      (queue.insertDispatched as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'reroute-job-1',
        inserted: false,
      });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const result = await dispatcher.dispatch(makeJobInput({ jobId: 'reroute-job-1' }));

      expect(result).toEqual({ status: 'duplicate', jobId: 'reroute-job-1' });
      expect(onDispatch).not.toHaveBeenCalled();
      // The claimed slot was released — the agent is back to idle.
      expect(registry.get('agent-1')!.activeJobs).toBe(0);
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
        // The claiming agent, recorded as the row's owner by the claim itself
        // so a won row is never observable as dispatched-with-no-owner.
        'scaler-firecracker-1',
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

    it('returns false when it claimed the bound job but its dispatch was refused', async () => {
      registry.register('scaler-firecracker-1', mockWs(), ['linux']);
      const boundJob = makeQueuedJob({ id: 'bound-1' });
      const queue = mockQueue({ dequeueJobs: [boundJob] });
      const refusing = vi.fn(async () => ({ refused: 'no clone credentials' }));
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch: refusing });

      const dispatched = await dispatcher.dispatchBoundJob('scaler-firecracker-1', 'bound-1');

      // fails-when: a claimed job that never reached the agent is reported as dispatched
      expect(dispatched).toBe(false);
      expect(queue.markFailed).toHaveBeenCalledWith('bound-1', 'no clone credentials');
      expect(registry.get('scaler-firecracker-1')!.activeJobs).toBe(0);
    });

    it('does not scale for a requeued job whose claim was refused rather than sent', async () => {
      registry.register('a1', mockWs(), ['linux']);
      const job = makeQueuedJob({ id: 'job-1', status: DispatchQueueStatus.Pending });
      const queue = mockQueue({ dequeueJobs: [job] });
      queue.getFullJobById = vi.fn().mockResolvedValue(job);
      const onNoMatchingAgent = vi.fn().mockResolvedValue({ action: 'spawning' });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch: vi.fn(async () => ({ refused: 'no clone credentials' })),
        onNoMatchingAgent,
      });

      await (dispatcher as unknown as { redispatch(jobId: string): Promise<void> }).redispatch(
        'job-1',
      );

      // breaks-if-wrong: a claim that failed the job ends the redispatch, with no spawn for it
      expect(queue.markFailed).toHaveBeenCalledWith('job-1', 'no clone credentials');
      expect(onNoMatchingAgent).not.toHaveBeenCalled();
    });
  });

  describe('redrivePendingToConnectedAgents (pending safety-net)', () => {
    it('does NOT re-drive a held label-routed post-restart job onto a reboot-pending host', async () => {
      // The safety-net re-drive must apply the same reboot-pending gate as
      // dispatch() / drainForAgent: a job held because its only matching host is
      // reboot-pending must stay pending, not be re-driven into the about-to-die
      // box. Without the gate this path defeats the workflow host-restart hold.
      const rosterStore = {
        isRebootPending: vi.fn(async (agentId: string) => agentId === 'restart-box'),
        clearRebootPending: vi.fn(),
      };
      registry.register('restart-box', mockWs(), ['kici:host:restart-box']);
      const job = makeQueuedJob({ id: 'verify-1', runsOnLabels: ['kici:host:restart-box'] });
      const queue = mockQueue({ depth: 1, pendingJobs: [job], dequeueJobs: [job] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch, rosterStore });

      const placed = await dispatcher.redrivePendingToConnectedAgents();

      expect(placed).toBe(0);
      expect(queue.dequeueById).not.toHaveBeenCalled();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('does NOT re-drive a held pinned post-restart job onto its reboot-pending host', async () => {
      const rosterStore = {
        isRebootPending: vi.fn(async (agentId: string) => agentId === 'restart-box'),
        clearRebootPending: vi.fn(),
      };
      registry.register('restart-box', mockWs(), ['kici:host:restart-box']);
      const job = makeQueuedJob({
        id: 'verify-1',
        runsOnLabels: ['kici:host:restart-box'],
        pinnedAgentId: 'restart-box',
      });
      const queue = mockQueue({ depth: 1, pendingJobs: [job], dequeueJobs: [job] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch, rosterStore });

      const placed = await dispatcher.redrivePendingToConnectedAgents();

      expect(placed).toBe(0);
      expect(queue.dequeueById).not.toHaveBeenCalled();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('places a pending job onto a connected idle matching agent via the atomic claim', async () => {
      registry.register('healthy', mockWs(), ['linux']);
      const job = makeQueuedJob({ id: 'orphan-1', runsOnLabels: ['linux'] });
      const queue = mockQueue({ depth: 1, pendingJobs: [job], dequeueJobs: [job] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const placed = await dispatcher.redrivePendingToConnectedAgents();

      expect(placed).toBe(1);
      expect(queue.dequeueById).toHaveBeenCalledWith(
        'orphan-1',
        expect.arrayContaining(['linux']),
        [],
        'healthy',
      );
      expect(onDispatch).toHaveBeenCalledWith('healthy', job);
      expect(registry.get('healthy')!.activeJobs).toBe(1);
    });

    it('recovers a requeued job the one-shot redispatch missed while the agent was transiently at capacity', async () => {
      registry.register('healthy', mockWs(), ['linux']);
      // Simulate the healthy agent's in-flight registration drain holding its
      // single eagerly-claimed slot at the instant the ack deadline fires.
      registry.incrementActiveJobs('healthy');

      const job = makeQueuedJob({ id: 'orphan-1', runsOnLabels: ['linux'], status: 'pending' });
      const queue = mockQueue({ depth: 1, pendingJobs: [job], dequeueJobs: [job] });
      queue.getFullJobById = vi.fn().mockResolvedValue(job);
      queue.listExpiredAckDeadlines = vi
        .fn()
        .mockResolvedValueOnce([
          { id: 'orphan-1', runId: 'run-1', agentId: 'suppressed', deadline: new Date(0) },
        ])
        .mockResolvedValue([]);
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      // Ack sweep requeues + one-shot redispatch — but the only matching agent
      // is transiently at capacity, so the job is left pending with no
      // re-trigger. This is the orphan the E2E flake reproduces.
      await dispatcher.sweepExpiredAckDeadlines();
      expect(onDispatch).not.toHaveBeenCalled();

      // The in-flight drain releases its slot; the next safety-net tick delivers.
      registry.decrementActiveJobs('healthy');
      const placed = await dispatcher.redrivePendingToConnectedAgents();

      expect(placed).toBe(1);
      expect(onDispatch).toHaveBeenCalledWith('healthy', job);
    });

    it('does not count a job it claimed but could not send as placed', async () => {
      registry.register('healthy', mockWs(), ['linux']);
      const job = makeQueuedJob({ id: 'orphan-1', runsOnLabels: ['linux'] });
      const queue = mockQueue({ depth: 1, pendingJobs: [job], dequeueJobs: [job] });
      const refusing = vi.fn(async () => ({ refused: 'no clone credentials' }));
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch: refusing });

      const placed = await dispatcher.redrivePendingToConnectedAgents();

      // fails-when: a refused claim is counted as a placement
      expect(placed).toBe(0);
      expect(refusing).toHaveBeenCalledWith('healthy', job);
      expect(queue.markFailed).toHaveBeenCalledWith('orphan-1', 'no clone credentials');
    });

    it('does not dispatch when the pending row was already claimed elsewhere (atomic-claim loser)', async () => {
      registry.register('healthy', mockWs(), ['linux']);
      const job = makeQueuedJob({ id: 'orphan-1', runsOnLabels: ['linux'] });
      // dequeueJobs empty => dequeueById returns null => this claim lost the row.
      const queue = mockQueue({ depth: 1, pendingJobs: [job], dequeueJobs: [] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const placed = await dispatcher.redrivePendingToConnectedAgents();

      expect(placed).toBe(0);
      expect(onDispatch).not.toHaveBeenCalled();
      expect(registry.get('healthy')!.activeJobs).toBe(0);
    });

    it('never routes a pinned job to a non-pinned agent even when labels match', async () => {
      registry.register('other', mockWs(), ['linux']);
      const job = makeQueuedJob({
        id: 'pinned-1',
        runsOnLabels: ['linux'],
        pinnedAgentId: 'absent-host',
      });
      const queue = mockQueue({ depth: 1, pendingJobs: [job], dequeueJobs: [job] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const placed = await dispatcher.redrivePendingToConnectedAgents();

      expect(placed).toBe(0);
      expect(queue.dequeueById).not.toHaveBeenCalled();
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('delivers a pinned job to its pinned agent when that agent is connected and idle', async () => {
      // The pinned agent is deliberately registered with a label the job does
      // NOT require, so `findAvailable(['linux'])` returns nothing and the ONLY
      // route to delivery is the pin branch of `selectConnectedTargetForPending`.
      // A mutation that broke pinned delivery (the branch returning null, or
      // falling through to the label matcher) would leave the job undelivered
      // and trip this assertion.
      registry.register('pinned-host', mockWs(), ['windows']);
      const job = makeQueuedJob({
        id: 'pinned-1',
        runsOnLabels: ['linux'],
        pinnedAgentId: 'pinned-host',
      });
      const queue = mockQueue({ depth: 1, pendingJobs: [job], dequeueJobs: [job] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const placed = await dispatcher.redrivePendingToConnectedAgents();

      expect(placed).toBe(1);
      expect(queue.dequeueById).toHaveBeenCalledWith(
        'pinned-1',
        expect.anything(),
        expect.anything(),
        'pinned-host',
      );
      expect(onDispatch).toHaveBeenCalledWith('pinned-host', job);
      expect(registry.get('pinned-host')!.activeJobs).toBe(1);
    });

    it('is a no-op when the queue is empty (does not even list pending)', async () => {
      registry.register('healthy', mockWs(), ['linux']);
      const queue = mockQueue({ depth: 0 });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const placed = await dispatcher.redrivePendingToConnectedAgents();

      expect(placed).toBe(0);
      expect(queue.listPending).not.toHaveBeenCalled();
    });

    it('does not consult the scaler even when a connected agent exists but cannot take the job', async () => {
      // A scaler hook is wired AND a connected agent exists, but that agent
      // cannot take the job (its labels do not match), so the sweep finds no
      // target — the realistic "no connected agent can take the job" case, not
      // the degenerate empty-fleet one. Spawning fresh capacity is
      // retryPendingScaleRequests' job, not this connected-agent sweep's, so a
      // future edit that added a scaler fallback on the no-target branch would
      // call onNoMatchingAgent here and trip this assertion.
      const onNoMatchingAgent = vi
        .fn()
        .mockResolvedValue({ action: 'spawning', backendType: 'docker' });
      registry.register('mismatch', mockWs(), ['windows']);
      const job = makeQueuedJob({ id: 'orphan-1', runsOnLabels: ['linux'] });
      const queue = mockQueue({ depth: 1, pendingJobs: [job], dequeueJobs: [job] });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      const placed = await dispatcher.redrivePendingToConnectedAgents();

      expect(placed).toBe(0);
      expect(onNoMatchingAgent).not.toHaveBeenCalled();
      expect(onDispatch).not.toHaveBeenCalled();
    });
  });

  describe('drain gate', () => {
    it('dispatch enqueues Pending and skips the agent + scaler while draining', async () => {
      // A free matching agent is present — proves we do NOT use it while draining.
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const onNoMatchingAgent = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
        isDraining: () => true,
      });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('queued');
      expect(queue.enqueue).toHaveBeenCalledOnce();
      expect(queue.insertDispatched).not.toHaveBeenCalled(); // no immediate dispatch
      expect(onNoMatchingAgent).not.toHaveBeenCalled(); // no scaler consult
      expect(onDispatch).not.toHaveBeenCalled();
      expect(registry.get('agent-1')!.activeJobs).toBe(0); // agent untouched
      expect(metrics.incJobsDispatched).toHaveBeenCalledWith('queued');
    });

    it('onAgentAvailable claims nothing while draining', async () => {
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        isDraining: () => true,
      });

      await dispatcher.onAgentAvailable('agent-1');

      expect(queue.dequeueForLabels).not.toHaveBeenCalled();
      expect(queue.dequeueByPinnedAgent).not.toHaveBeenCalled();
    });

    it('dispatch behaves normally when not draining', async () => {
      registry.register('agent-1', mockWs(), ['linux']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        isDraining: () => false,
      });

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('dispatched');
    });

    it('queues a pinned job (with the pin) instead of dispatching while draining', async () => {
      // The pinned agent is present, free, and matches — proves the drain gate,
      // not agent unavailability, holds the job.
      registry.register('a1', mockWs(), ['role:web']);
      const queue = mockQueue();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        isDraining: () => true,
      });

      const result = await dispatcher.dispatch(
        makeJobInput({ runsOnLabels: ['role:web'], pinnedAgentId: 'a1' }),
      );

      expect(result.status).toBe('queued');
      expect(onDispatch).not.toHaveBeenCalled();
      expect(queue.insertDispatched).not.toHaveBeenCalled();
      // The pin is preserved so post-restart recovery delivers it to a1.
      expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ pinnedAgentId: 'a1' }));
      expect(registry.get('a1')!.activeJobs).toBe(0);
    });

    it('dispatchBoundJob claims nothing while draining', async () => {
      registry.register('scaler-firecracker-1', mockWs(), ['linux', 'firecracker']);
      const boundJob = makeQueuedJob({ id: 'bound-1', runsOnLabels: ['firecracker'] });
      const queue = mockQueue({ dequeueJobs: [boundJob] });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        isDraining: () => true,
      });

      const dispatched = await dispatcher.dispatchBoundJob('scaler-firecracker-1', 'bound-1');

      expect(dispatched).toBe(false);
      expect(queue.dequeueById).not.toHaveBeenCalled();
      expect(queue.markDispatched).not.toHaveBeenCalled();
      expect(onDispatch).not.toHaveBeenCalled();
      expect(registry.get('scaler-firecracker-1')!.activeJobs).toBe(0);
    });
  });

  describe('agent suitability', () => {
    /** A warm agent's scaler record whose shape check answers `verdict`. */
    const warmView = (verdict: boolean) => ({
      prespawned: true,
      shapeFits: vi.fn().mockReturnValue(verdict),
    });

    /**
     * One label-matching warm agent whose shape check answers `verdict`. The
     * question every case here asks is whether the job reaches that agent or
     * falls through to the scaler.
     */
    function withOneAgent(verdict: boolean, queue = mockQueue(), agentLabels = ['linux']) {
      registry.register('warm-1', mockWs(), agentLabels);
      const onNoMatchingAgent = vi
        .fn()
        .mockResolvedValue({ action: 'spawning', backendType: 'docker' });
      const view = warmView(verdict);
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
        scalerAgentView: (id) => (id === 'warm-1' ? view : undefined),
      });
      return { dispatcher, onNoMatchingAgent, shapeFits: view.shapeFits };
    }

    it('skips a pre-spawned agent that cannot serve the job and scales instead', async () => {
      const { dispatcher, onNoMatchingAgent } = withOneAgent(false);

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('queued');
      expect(onDispatch).not.toHaveBeenCalled();
      expect(onNoMatchingAgent).toHaveBeenCalled();
    });

    it('dispatches to a pre-spawned agent the scaler accepts', async () => {
      const { dispatcher, onNoMatchingAgent } = withOneAgent(true);

      const result = await dispatcher.dispatch(makeJobInput());

      expect(result.status).toBe('dispatched');
      expect(onDispatch).toHaveBeenCalled();
      expect(onNoMatchingAgent).not.toHaveBeenCalled();
    });

    it("checks a warm agent's shape against the job's own resources", async () => {
      const { dispatcher, shapeFits } = withOneAgent(true);
      const resources = { requests: { cpus: 4, memory: '8g' } };

      await dispatcher.dispatch(makeJobInput({ resources }));

      expect(shapeFits).toHaveBeenCalledWith(resources);
    });

    it('scales for an image job rather than hand it to a warm agent with no runtime', async () => {
      const { dispatcher, onNoMatchingAgent, shapeFits } = withOneAgent(true);

      const result = await dispatcher.dispatch(
        makeJobInput({ jobConfig: { container: 'node:22-bookworm' } }),
      );

      // fails-when: the image job lands on a pool agent that cannot start it
      expect(result.status).toBe('queued');
      expect(onNoMatchingAgent).toHaveBeenCalled();
      expect(shapeFits).not.toHaveBeenCalled();
    });

    it('recognizes a rerouted job by its preassigned id on the agent started for it', async () => {
      registry.register('image-1', mockWs(), ['linux']);
      const dispatcher = new Dispatcher({
        registry,
        queue: mockQueue(),
        metrics,
        onDispatch,
        onNoMatchingAgent: vi.fn().mockResolvedValue({ action: 'at-capacity' }),
        scalerAgentView: () => ({
          binding: { jobId: 'rerouted-1', jobImage: true },
          prespawned: false,
          shapeFits: () => true,
        }),
      });

      // fails-when: the id is dropped, so the agent started for a rerouted job
      // no longer recognizes it and refuses it like any other job
      expect((await dispatcher.dispatch(makeJobInput({ jobId: 'rerouted-1' }))).status).toBe(
        'dispatched',
      );
      expect((await dispatcher.dispatch(makeJobInput({ jobId: 'other-1' }))).status).toBe('queued');
    });

    // The typed `resources` field is a convenience mirror the caller may omit:
    // the webhook dispatch path and the worker's reroute handler both build
    // their input with the declaration in `jobConfig` alone. Reading only the
    // mirror reported a job that declares nothing, so the gate admitted a warm
    // agent of the pool's size to a job that asked for another.
    it('reads the declared shape from jobConfig when the typed mirror is absent', async () => {
      const { dispatcher, shapeFits } = withOneAgent(true);
      const resources = { requests: { cpus: 8, memory: '16g' } };

      await dispatcher.dispatch(makeJobInput({ jobConfig: { resources } }));

      expect(shapeFits).toHaveBeenCalledWith(resources);
    });

    it('scales for a jobConfig-only shape when no agent fits', async () => {
      const { dispatcher, onNoMatchingAgent } = withOneAgent(false);

      await dispatcher.dispatch(
        makeJobInput({ jobConfig: { resources: { requests: { cpus: 8 } } } }),
      );

      // The 5th argument is the shape the spawn is sized from. Read as absent,
      // the scaler starts the job's own agent at the label-set default.
      expect(onNoMatchingAgent.mock.calls[0][4]).toEqual({ requests: { cpus: 8 } });
    });

    it('carries a jobConfig-only shape into the queue drain too', async () => {
      const queue = mockQueue();
      const { dispatcher, shapeFits } = withOneAgent(false, queue);

      await dispatcher.onAgentAvailable('warm-1');

      const canServe = (queue.dequeueForLabels as ReturnType<typeof vi.fn>).mock.calls[0][3] as (
        job: QueuedJob,
      ) => boolean;
      // A row whose mirror never got materialized still has to be gated on the
      // shape its jobConfig declares — `makeQueuedJob` sets no `resources`.
      expect(canServe(makeQueuedJob({ jobConfig: { resources: { requests: { cpus: 8 } } } }))).toBe(
        false,
      );
      expect(shapeFits).toHaveBeenCalledWith({ requests: { cpus: 8 } });
    });

    it('treats a dockerfile job as needing a runtime a build CLI does not provide', async () => {
      // A dockerfile job additionally requires the build-capable runtime label,
      // and it runs the pool's agent image nesting a container it builds — so
      // it needs a runtime socket too, and brings no image a spawn could start.
      const { dispatcher, onNoMatchingAgent } = withOneAgent(true, mockQueue(), [
        'linux',
        'kici:runtime:container-build',
      ]);

      const result = await dispatcher.dispatch(
        makeJobInput({ jobConfig: { container: { dockerfile: 'Dockerfile' } } }),
      );

      expect(result.status).toBe('queued');
      expect(onNoMatchingAgent).toHaveBeenCalled();
    });

    it('dispatches to an agent that predates runtime labels when no scaler is wired', async () => {
      registry.register('static-1', mockWs(), ['linux']);
      const onNoMatchingAgent = vi
        .fn()
        .mockResolvedValue({ action: 'spawning', backendType: 'docker' });
      const dispatcher = new Dispatcher({
        registry,
        queue: mockQueue(),
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      // breaks-if-wrong: an agent whose silence proves nothing keeps its jobs
      const result = await dispatcher.dispatch(
        makeJobInput({ jobConfig: { container: 'node:22-bookworm' } }),
      );

      expect(result.status).toBe('dispatched');
      expect(onNoMatchingAgent).not.toHaveBeenCalled();
    });

    it("keeps a container job off an operator's agent that reports no runtime, with no scaler wired", async () => {
      registry.register('static-1', mockWs(), ['linux'], 'linux', 'x64', '0.10.0');
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      // fails-when: a 0.10.0 agent with no socket takes the job and fails it
      const container = await dispatcher.dispatch(
        makeJobInput({ jobConfig: { container: 'node:22-bookworm' } }),
      );
      expect(container.status).toBe('queued');
      expect(onDispatch).not.toHaveBeenCalled();

      // The same agent still takes a plain job.
      expect((await dispatcher.dispatch(makeJobInput())).status).toBe('dispatched');
    });

    it('reports no backend when the only label-matching agent cannot run the job', async () => {
      registry.register('static-1', mockWs(), ['linux'], 'linux', 'x64', '0.10.0');
      const dispatcher = new Dispatcher({
        registry,
        queue: mockQueue(),
        metrics,
        onDispatch,
        onNoMatchingAgent: vi.fn().mockResolvedValue({ action: 'no-backend', labels: ['linux'] }),
      });

      // fails-when: the runtime-less agent counts as a match, so the job waits
      // here instead of being offered to a peer that can run it
      const result = await dispatcher.dispatch(
        makeJobInput({ jobConfig: { container: 'node:22-bookworm' } }),
      );

      expect(result.status).toBe('queued-no-backend');
    });

    it('skips an unsuitable scaler agent on the redispatch path too', async () => {
      const job = makeQueuedJob({ id: 'requeued-1', status: 'pending' });
      const queue = mockQueue({ dequeueJobs: [job] });
      (queue.getFullJobById as ReturnType<typeof vi.fn>).mockResolvedValue(job);
      const { dispatcher, onNoMatchingAgent } = withOneAgent(false, queue);

      await (dispatcher as unknown as { redispatch(jobId: string): Promise<void> }).redispatch(
        'requeued-1',
      );

      expect(queue.dequeueById).not.toHaveBeenCalled();
      expect(onNoMatchingAgent).toHaveBeenCalled();
    });

    it('carries the suitability gate into the queue drain for an agent that may refuse', async () => {
      const queue = mockQueue();
      const { dispatcher, shapeFits } = withOneAgent(false, queue);

      await dispatcher.onAgentAvailable('warm-1');

      // The predicate reaches the claim itself: a row rejected after being
      // claimed would be stranded Dispatched and would burn a dispatch attempt.
      const canServe = (queue.dequeueForLabels as ReturnType<typeof vi.fn>).mock.calls[0][3] as (
        job: QueuedJob,
      ) => boolean;
      expect(canServe(makeQueuedJob({ resources: { requests: { cpus: 8 } } }))).toBe(false);
      expect(shapeFits).toHaveBeenCalledWith({ requests: { cpus: 8 } });
    });

    it('leaves the queue drain unfiltered for an agent that runs any job', async () => {
      const queue = mockQueue();
      registry.register(
        'static-1',
        mockWs(),
        ['linux', 'kici:runtime:docker'],
        'linux',
        'x64',
        '0.10.0',
      );
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        scalerAgentView: () => undefined,
      });

      await dispatcher.onAgentAvailable('static-1');

      // No predicate, so the drain keeps its single-statement fast path.
      expect((queue.dequeueForLabels as ReturnType<typeof vi.fn>).mock.calls[0][3]).toBeUndefined();
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
        undefined,
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
        undefined,
        undefined,
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
        undefined,
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

  describe('retryPendingScaleRequests (capacity-freed re-drive)', () => {
    it('re-offers each pending job to onNoMatchingAgent, oldest first, with dispatch-time args', async () => {
      const pendingJobs = [
        makeQueuedJob({
          id: 'old',
          runId: 'run-old',
          runsOnLabels: ['linux'],
          excludeLabels: ['windows'],
        }),
        makeQueuedJob({ id: 'new', runId: 'run-new', runsOnLabels: ['docker'] }),
      ];
      const queue = mockQueue({ pendingJobs });
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

      const redriven = await dispatcher.retryPendingScaleRequests();

      expect(redriven).toBe(2);
      expect(onNoMatchingAgent).toHaveBeenCalledTimes(2);
      expect(onNoMatchingAgent).toHaveBeenNthCalledWith(
        1,
        ['linux'],
        'old',
        'run-old',
        ['windows'],
        undefined,
        undefined,
        undefined,
      );
      expect(onNoMatchingAgent).toHaveBeenNthCalledWith(
        2,
        ['docker'],
        'new',
        'run-new',
        [],
        undefined,
        undefined,
        undefined,
      );
      expect(metrics.incScalerRedispatch).toHaveBeenCalledWith('hook', 2);
    });

    it('hands the scaler the job image + resolved credentials', async () => {
      const onNoMatchingAgent = vi.fn().mockResolvedValue({ action: 'spawning' });
      const pendingJobs = [
        makeQueuedJob({
          id: 'ctr',
          runId: 'run-ctr',
          runsOnLabels: ['linux'],
          jobConfig: {
            container: { image: 'reg.internal:5000/acme/ci:1.2' },
            containerRegistryAuth: {
              username: 'bot',
              password: 's3cr3t',
              serveraddress: 'reg.internal:5000',
            },
          },
        }),
      ];
      const dispatcher = new Dispatcher({
        registry,
        queue: mockQueue({ pendingJobs }),
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      await dispatcher.retryPendingScaleRequests(10);

      const [labels, , , , , , containerSpawn] = onNoMatchingAgent.mock.calls[0] as [
        string[],
        string,
        string,
        string[],
        unknown,
        unknown,
        { image: string; authconfig?: unknown } | undefined,
      ];
      // Labels are passed through untouched: the scaler picks a pool by exact
      // label-set containment, so a runtime label no pool declares would strand
      // the job. Runtime is judged on registered agents instead (see
      // container-routing.ts).
      expect(labels).toEqual(['linux']);
      // Assembled from what dispatch already resolved — never re-resolved here.
      expect(containerSpawn?.image).toBe('reg.internal:5000/acme/ci:1.2');
      expect(containerSpawn?.authconfig).toEqual({
        username: 'bot',
        password: 's3cr3t',
        serveraddress: 'reg.internal:5000',
      });
    });

    it('leaves a non-container job with no spawn context at all', async () => {
      const onNoMatchingAgent = vi.fn().mockResolvedValue({ action: 'spawning' });
      const dispatcher = new Dispatcher({
        registry,
        queue: mockQueue({ pendingJobs: [makeQueuedJob({ id: 'plain' })] }),
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      await dispatcher.retryPendingScaleRequests(10);

      const [labels, , , , , , containerSpawn] = onNoMatchingAgent.mock.calls[0] as [
        string[],
        string,
        string,
        string[],
        unknown,
        unknown,
        unknown,
      ];
      expect(labels).toEqual(['linux']);
      expect(containerSpawn).toBeUndefined();
    });

    it('respects the maxJobs cap (re-drives only the oldest)', async () => {
      const pendingJobs = [
        makeQueuedJob({ id: 'old', runId: 'run-old' }),
        makeQueuedJob({ id: 'new', runId: 'run-new' }),
      ];
      const queue = mockQueue({ pendingJobs });
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

      const redriven = await dispatcher.retryPendingScaleRequests(1);

      expect(queue.listPending).toHaveBeenCalledWith(1);
      expect(redriven).toBe(1);
      expect(onNoMatchingAgent).toHaveBeenCalledTimes(1);
      expect(onNoMatchingAgent).toHaveBeenCalledWith(
        ['linux'],
        'old',
        'run-old',
        [],
        undefined,
        undefined,
        undefined,
      );
    });

    it('passes the trigger label through to the metric', async () => {
      const queue = mockQueue({ pendingJobs: [makeQueuedJob()] });
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

      await dispatcher.retryPendingScaleRequests(10, 'sweep');

      expect(metrics.incScalerRedispatch).toHaveBeenCalledWith('sweep', 1);
    });

    it('does not count (or emit) jobs that stay at-capacity', async () => {
      const queue = mockQueue({ pendingJobs: [makeQueuedJob()] });
      const onNoMatchingAgent = vi.fn().mockResolvedValue({ action: 'at-capacity' });
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      const redriven = await dispatcher.retryPendingScaleRequests();

      expect(redriven).toBe(0);
      expect(metrics.incScalerRedispatch).not.toHaveBeenCalled();
    });

    it('returns 0 and does not throw when no scaler hook is configured', async () => {
      const queue = mockQueue({ pendingJobs: [makeQueuedJob()] });
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      const redriven = await dispatcher.retryPendingScaleRequests();

      expect(redriven).toBe(0);
      expect(queue.listPending).not.toHaveBeenCalled();
    });

    it('is single-flight: a concurrent call while one is in flight returns 0', async () => {
      const queue = mockQueue({ pendingJobs: [makeQueuedJob()] });
      let releaseFirst: (r: { action: 'spawning'; backendType: string }) => void = () => {};
      const onNoMatchingAgent = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      );
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics,
        onDispatch,
        onNoMatchingAgent,
      });

      const first = dispatcher.retryPendingScaleRequests();
      // Second call races in while the first is still awaiting onNoMatchingAgent.
      const second = await dispatcher.retryPendingScaleRequests();
      expect(second).toBe(0);

      releaseFirst({ action: 'spawning', backendType: 'docker' });
      expect(await first).toBe(1);
      expect(onNoMatchingAgent).toHaveBeenCalledTimes(1);
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

    it('a boot-swept job is reclaimable by the agent that owned it', async () => {
      vi.useFakeTimers();
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      // The boot sweep passes the owner it read off the dispatched row.
      await dispatcher.startRecoveryTimer('job-42', 'agent-1', 'run-42');

      expect(queue.markRecovering).toHaveBeenCalledWith('job-42', expect.any(Date), 'agent-1');
      expect(dispatcher.claimRecovery('job-42', 'agent-1')).toBe(true);

      dispatcher.stopRecoveryTimers();
    });

    it('a boot-swept job is not reclaimable by a different agent', async () => {
      vi.useFakeTimers();
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.startRecoveryTimer('job-42', 'agent-1', 'run-42');

      expect(dispatcher.claimRecovery('job-42', 'agent-2')).toBe(false);

      dispatcher.stopRecoveryTimers();
    });

    it('a boot-swept job with no recorded owner stays unclaimable', async () => {
      vi.useFakeTimers();
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      // A row dispatched before the owner column existed: the sweep falls back
      // to the placeholder, so no real agent id can claim it.
      await dispatcher.startRecoveryTimer('job-42', 'unknown', 'run-42');

      expect(dispatcher.claimRecovery('job-42', 'agent-1')).toBe(false);

      dispatcher.stopRecoveryTimers();
    });

    it('reconcileRecovery records the reclaiming agent as the durable owner', async () => {
      vi.useFakeTimers();
      const queue = mockQueue();
      const dispatcher = new Dispatcher({ registry, queue, metrics, onDispatch });

      await dispatcher.startRecoveryTimer('job-42', 'agent-1', 'run-42');

      await expect(dispatcher.reconcileRecovery('job-42', 'agent-1')).resolves.toBe(true);
      expect(queue.markDispatchedIfRecovering).toHaveBeenCalledWith('job-42', 'agent-1');

      dispatcher.stopRecoveryTimers();
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

      await dispatcher.onJobRejected('zzz-rejecter', 'job-1', JobRejectReason.enum.busy);

      expect(requeue).toHaveBeenCalledWith('job-1', { countAttempt: false });
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
      await dispatcher.onJobRejected('a1', 'unknown-job', JobRejectReason.enum.busy);
      expect(requeue).not.toHaveBeenCalled();
    });

    it('fails the job permanently when a hard rejection exhausts the attempts', async () => {
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

      await dispatcher.onJobRejected('a1', 'job-1', JobRejectReason.enum.draining);

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

      await dispatcher.onJobRejected('busy-agent', 'job-1', JobRejectReason.enum.busy);

      expect(onNoMatchingAgent).toHaveBeenCalledWith(
        ['linux'],
        'job-1',
        'run-1',
        [],
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('onJobRejected — busy agent tearing down its previous job', () => {
    /**
     * A queue whose requeue counts attempts the way the real one does, so a
     * burst of rejections shows whether the budget is spent.
     */
    function countingQueue(fullJob: QueuedJob) {
      let attempts = 0;
      const requeue = vi.fn(async (_id: string, opts: { countAttempt?: boolean } = {}) => {
        if (opts.countAttempt !== false) attempts++;
        return attempts;
      });
      const markFailed = vi.fn(async () => {});
      const queue = {
        ...mockQueue(),
        requeue,
        markFailed,
        getFullJobById: vi.fn(async () => fullJob),
        dequeueById: vi.fn(async () => fullJob),
        getDepth: vi.fn(async () => 0),
      } as unknown as JobQueue;
      return { queue, requeue, markFailed };
    }

    it('does not re-pick the busy agent and spends no attempts across normal teardowns', async () => {
      const registry = new AgentRegistry();
      registry.register('a1', mockWs(), ['linux']);
      const fullJob = makeQueuedJob({ id: 'job-1', status: DispatchQueueStatus.Pending });
      const { queue, requeue, markFailed } = countingQueue(fullJob);
      const onDispatch = vi.fn();
      const onNoMatchingAgent = vi.fn(async (): Promise<ScaleResult> => ({
        action: 'at-capacity',
      }));
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch,
        onNoMatchingAgent,
      });

      // The agent rejects busy more times than the attempt budget allows, and
      // reports an empty slot after each teardown (agent.status activeJobs: 0).
      for (let i = 0; i < MAX_DISPATCH_ATTEMPTS + 1; i++) {
        if (i > 0) registry.clearBusyHeld('a1');
        registry.incrementActiveJobs('a1');
        dispatcher.restoreJobForAgent('a1', 'job-1');
        await dispatcher.onJobRejected('a1', 'job-1', JobRejectReason.enum.busy);
      }

      // breaks-if-wrong: a busy rejection after a free-slot report spends an
      // attempt — ordinary teardown races fail the job.
      expect(markFailed).not.toHaveBeenCalled();
      expect(requeue).toHaveBeenLastCalledWith('job-1', { countAttempt: false });
      // fails-when: the busy agent is not held — the redispatch lands on it again.
      expect(onDispatch).not.toHaveBeenCalled();
      expect(registry.findAvailable(['linux'])).toEqual([]);
      // With no other agent free, the requeued job goes to the scaler instead.
      expect(onNoMatchingAgent).toHaveBeenCalled();
    });

    it('fails the job when an agent with a stuck job count keeps rejecting busy', async () => {
      vi.useFakeTimers();
      try {
        const registry = new AgentRegistry();
        registry.register('a1', mockWs(), ['linux']);
        const fullJob = makeQueuedJob({ id: 'job-1', status: DispatchQueueStatus.Pending });
        const { queue, requeue, markFailed } = countingQueue(fullJob);
        const onJobFailedPermanently = vi.fn();
        const dispatcher = new Dispatcher({
          registry,
          queue,
          metrics: mockMetrics(),
          onDispatch: vi.fn(),
          onJobFailedPermanently,
        });
        const rejectOnce = async () => {
          registry.incrementActiveJobs('a1');
          dispatcher.restoreJobForAgent('a1', 'job-1');
          await dispatcher.onJobRejected('a1', 'job-1', JobRejectReason.enum.busy);
        };

        // The agent never reports an empty slot, so each hold lifts only by
        // expiry. The first rejection is free; every one after an expiry counts.
        await rejectOnce();
        expect(requeue).toHaveBeenLastCalledWith('job-1', { countAttempt: false });
        for (let i = 0; i < MAX_DISPATCH_ATTEMPTS; i++) {
          vi.advanceTimersByTime(BUSY_HOLD_MAX_MS);
          await rejectOnce();
          expect(requeue).toHaveBeenLastCalledWith('job-1', { countAttempt: true });
        }

        // fails-when: a busy rejection after an expired hold spends no attempt —
        // the stuck agent holds the job pending forever.
        expect(markFailed).toHaveBeenCalledTimes(1);
        expect(markFailed).toHaveBeenCalledWith(
          'job-1',
          expect.stringContaining('attempts exhausted'),
        );
        expect(onJobFailedPermanently).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('routes the requeued job to another idle agent', async () => {
      const registry = new AgentRegistry();
      // 'a1-busy' sorts first, so deterministic selection would re-pick it
      // were it not held.
      registry.register('a1-busy', mockWs(), ['linux']);
      registry.register('b2-idle', mockWs(), ['linux']);
      const fullJob = makeQueuedJob({ id: 'job-1', status: DispatchQueueStatus.Pending });
      const { queue } = countingQueue(fullJob);
      const onDispatch = vi.fn();
      const dispatcher = new Dispatcher({ registry, queue, metrics: mockMetrics(), onDispatch });
      registry.incrementActiveJobs('a1-busy');
      dispatcher.restoreJobForAgent('a1-busy', 'job-1');

      await dispatcher.onJobRejected('a1-busy', 'job-1', JobRejectReason.enum.busy);

      // fails-when: the hold is missing — selection re-picks a1-busy.
      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(onDispatch).toHaveBeenCalledWith('b2-idle', expect.objectContaining({ id: 'job-1' }));
    });

    it('drains the job onto the agent once it reports a free slot', async () => {
      const registry = new AgentRegistry();
      registry.register('a1', mockWs(), ['linux']);
      const fullJob = makeQueuedJob({ id: 'job-1', status: DispatchQueueStatus.Pending });
      const { queue } = countingQueue(fullJob);
      (queue.dequeueForLabels as ReturnType<typeof vi.fn>).mockResolvedValue(fullJob);
      const onDispatch = vi.fn();
      const dispatcher = new Dispatcher({ registry, queue, metrics: mockMetrics(), onDispatch });
      registry.incrementActiveJobs('a1');
      dispatcher.restoreJobForAgent('a1', 'job-1');
      await dispatcher.onJobRejected('a1', 'job-1', JobRejectReason.enum.busy);

      // Still held: a drain trigger claims nothing.
      await dispatcher.onAgentAvailable('a1');
      expect(onDispatch).not.toHaveBeenCalled();

      // breaks-if-wrong: the agent finished tearing down and reported a free
      // slot (agent.status lifts the hold); the waiting job must reach it.
      registry.clearBusyHeld('a1');
      await dispatcher.onAgentAvailable('a1');
      expect(onDispatch).toHaveBeenCalledWith('a1', expect.objectContaining({ id: 'job-1' }));
    });

    it('a hard rejection spends an attempt and does not hold the agent', async () => {
      const registry = new AgentRegistry();
      registry.register('a1', mockWs(), ['linux']);
      const fullJob = makeQueuedJob({ id: 'job-1', status: DispatchQueueStatus.Pending });
      const { queue, requeue } = countingQueue(fullJob);
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
      });
      registry.incrementActiveJobs('a1');
      dispatcher.restoreJobForAgent('a1', 'job-1');

      await dispatcher.onJobRejected('a1', 'job-1', JobRejectReason.enum.draining);

      // breaks-if-wrong: the hard-rejection path keeps counting attempts.
      expect(requeue).toHaveBeenCalledWith('job-1', { countAttempt: true });
      await expect(requeue.mock.results[0]!.value).resolves.toBe(1);
      expect(registry.get('a1')?.busyHeldUntil).toBeUndefined();
    });

    describe('work the agent accepted or finished after its hold was set', () => {
      /**
       * One agent `a1` (and optionally a second, busy agent `a2`) behind a
       * dispatcher whose queue counts attempts. The agent.status that would
       * lift a hold never arrives in any of these tests.
       */
      function setup(opts: { a1MaxConcurrency?: number; withBusyA2?: boolean } = {}) {
        const registry = new AgentRegistry();
        registry.register(
          'a1',
          mockWs(),
          ['linux'],
          'linux',
          'x64',
          undefined,
          opts.a1MaxConcurrency ?? 1,
        );
        if (opts.withBusyA2) registry.register('a2', mockWs(), ['linux']);
        const fullJob = makeQueuedJob({ id: 'job-1', status: DispatchQueueStatus.Pending });
        const { queue, requeue } = countingQueue(fullJob);
        const onDispatch = vi.fn();
        const dispatcher = new Dispatcher({ registry, queue, metrics: mockMetrics(), onDispatch });
        /** Put a job on an agent the way a dispatch does: one slot, tracked to it. */
        const occupy = (agentId: string, jobId: string) => {
          registry.incrementActiveJobs(agentId);
          dispatcher.restoreJobForAgent(agentId, jobId);
        };
        if (opts.withBusyA2) occupy('a2', 'job-a2');
        const rejectBusy = async () => {
          occupy('a1', 'job-1');
          await dispatcher.onJobRejected('a1', 'job-1', JobRejectReason.enum.busy);
        };
        /** The queue drain that hands `jobId` to `a1` once its hold allows it. */
        const drainOnto = async (jobId: string) => {
          (queue.dequeueForLabels as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
            makeQueuedJob({ id: jobId, status: DispatchQueueStatus.Pending }),
          );
          await dispatcher.onAgentAvailable('a1');
          expect(onDispatch).toHaveBeenCalledWith('a1', expect.objectContaining({ id: jobId }));
        };
        return { registry, dispatcher, requeue, occupy, rejectBusy, drainOnto };
      }

      it('a job finishing on the agent after its hold ran out lifts the hold, so the next busy rejection spends no attempt', async () => {
        vi.useFakeTimers();
        try {
          const { registry, dispatcher, requeue, rejectBusy, drainOnto } = setup();
          await rejectBusy();
          expect(requeue).toHaveBeenLastCalledWith('job-1', { countAttempt: false });
          // The agent.status that reports the free slot is lost; the hold runs
          // out and the drain hands the agent its next job, which it runs.
          vi.advanceTimersByTime(BUSY_HOLD_MAX_MS);
          await drainOnto('job-2');
          dispatcher.onJobComplete('a1', 'job-2');
          // fails-when: only agent.status lifts a hold — the expired hold stays
          // on the entry of an agent that just finished a job.
          expect(registry.get('a1')?.busyHeldUntil).toBeUndefined();

          // The teardown-window rejection after job-2.
          await rejectBusy();
          // breaks-if-wrong: a healthy agent is charged an attempt because one
          // free-slot status was lost.
          expect(requeue).toHaveBeenLastCalledWith('job-1', { countAttempt: false });
        } finally {
          vi.useRealTimers();
        }
      });

      it('a job finishing on a multi-slot agent lifts a hold still in force', async () => {
        const { registry, dispatcher, requeue, occupy, rejectBusy } = setup({
          a1MaxConcurrency: 2,
        });
        // The agent runs one job at a time: a second dispatch is refused busy.
        occupy('a1', 'job-running');
        await rejectBusy();
        expect(registry.get('a1')?.busyHeldUntil).toBeDefined();

        dispatcher.onJobComplete('a1', 'job-running');
        // fails-when: the finished job leaves the hold in force — a teardown
        // longer than the rest of the hold charges the next rejection.
        expect(registry.get('a1')?.busyHeldUntil).toBeUndefined();
        await rejectBusy();
        expect(requeue).toHaveBeenLastCalledWith('job-1', { countAttempt: false });
      });

      it('a job finishing on another agent leaves the hold, and the expiry still charges an attempt', async () => {
        vi.useFakeTimers();
        try {
          const { registry, dispatcher, requeue, rejectBusy } = setup({ withBusyA2: true });
          await rejectBusy();
          dispatcher.onJobComplete('a2', 'job-a2');
          // fails-when: any completion lifts every hold — a stuck agent is
          // never charged.
          expect(registry.get('a1')?.busyHeldUntil).toBeDefined();

          vi.advanceTimersByTime(BUSY_HOLD_MAX_MS);
          await rejectBusy();
          // breaks-if-wrong: an agent re-picked only because its hold ran out
          // still spends an attempt.
          expect(requeue).toHaveBeenLastCalledWith('job-1', { countAttempt: true });
        } finally {
          vi.useRealTimers();
        }
      });

      it('a terminal frame for a job not tracked to the agent leaves the hold', async () => {
        const { registry, dispatcher, rejectBusy } = setup();
        await rejectBusy();
        // A replayed frame for a job already completed, or one never dispatched here.
        dispatcher.onJobComplete('a1', 'job-not-on-a1');
        // fails-when: a stray or replayed terminal frame lifts the hold.
        expect(registry.get('a1')?.busyHeldUntil).toBeDefined();
      });

      it('an ack for a job dispatched after the hold ran out lifts it', async () => {
        vi.useFakeTimers();
        try {
          const { registry, dispatcher, requeue, rejectBusy, drainOnto } = setup();
          await rejectBusy();
          vi.advanceTimersByTime(BUSY_HOLD_MAX_MS);
          // fails-when: an ack for a job never dispatched to a1 drops its hold.
          dispatcher.onJobAcked('a1', 'job-not-on-a1');
          expect(registry.get('a1')?.busyHeldUntil).toBeDefined();
          await drainOnto('job-2');
          dispatcher.onJobAcked('a1', 'job-2');
          // fails-when: an ack leaves the expired hold, so the rejection after
          // job-2 finishes is charged.
          expect(registry.get('a1')?.busyHeldUntil).toBeUndefined();
          await rejectBusy();
          expect(requeue).toHaveBeenLastCalledWith('job-1', { countAttempt: false });
        } finally {
          vi.useRealTimers();
        }
      });

      it('a running status for a job dispatched after the hold ran out lifts it', async () => {
        vi.useFakeTimers();
        try {
          const { registry, dispatcher, rejectBusy, drainOnto } = setup();
          await rejectBusy();
          vi.advanceTimersByTime(BUSY_HOLD_MAX_MS);
          await drainOnto('job-2');
          // The ack was lost; `job.status: running` stands in for it.
          dispatcher.markJobStarted('job-2');
          // fails-when: the running status is not read as accepted work.
          expect(registry.get('a1')?.busyHeldUntil).toBeUndefined();
        } finally {
          vi.useRealTimers();
        }
      });

      it('an ack while the hold is in force leaves it: the acked job occupies the slot', async () => {
        const { registry, dispatcher, occupy, rejectBusy } = setup({ a1MaxConcurrency: 2 });
        // Accepted before the rejection, but its ack is processed after it.
        occupy('a1', 'job-running');
        await rejectBusy();
        dispatcher.onJobAcked('a1', 'job-running');
        dispatcher.markJobStarted('job-running');
        // fails-when: accepted work lifts a hold in force — the busy agent is
        // re-picked at once.
        expect(registry.get('a1')?.busyHeldUntil).toBeDefined();
        expect(registry.findAvailable(['linux'])).toEqual([]);
      });
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
      expect(requeue).toHaveBeenCalledWith('job-1', { countAttempt: true });
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

      // The requeue is the guarded one: it proves the ack never landed and
      // flips the row in the same statement, so an acked job is never requeued.
      expect(queue.requeueIfAwaitingAck).toHaveBeenCalledWith(jobId, 'a1');
      expect(queue.requeue).not.toHaveBeenCalled();
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
      const jobId = ((await insertMock.mock.results[0].value) as { id: string }).id;

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
      await dispatcher.onJobRejected('a1', jobId, JobRejectReason.enum.busy);

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

      expect(queue.requeueIfAwaitingAck).toHaveBeenCalledWith(jobId, 'a1');
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

      expect(queue.requeue).toHaveBeenCalledWith(jobId, { countAttempt: true });
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

      expect(queue.requeueIfAwaitingAck).toHaveBeenCalledWith('job-r', 'a1');
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
      expect(queue.requeueIfAwaitingAck).toHaveBeenCalledWith('job-s', 'a1');
      expect(queue.requeue).not.toHaveBeenCalled();
      expect(onAckTimeout).toHaveBeenCalledWith('a1', 'job-s', 'run-s');
    });

    it('a late ack timer whose ack already landed leaves the running job alone', async () => {
      // The DB is the arbiter: the guarded requeue reports that the row is no
      // longer awaiting this agent's ack, which is how a coordinator learns the
      // ack reached a sibling. Requeueing here would hand an executing job to a
      // second agent, and unregistering would tear down a healthy one.
      vi.useFakeTimers();
      registry.register('a1', mockWs(), ['linux']);
      const queue = mockQueue();
      (queue.requeueIfAwaitingAck as ReturnType<typeof vi.fn>).mockResolvedValue(null);
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
      expect(result.status).toBe('dispatched');
      const jobId = (result as { status: 'dispatched'; jobId: string }).jobId;
      await vi.advanceTimersByTimeAsync(5_001);

      expect(queue.requeueIfAwaitingAck).toHaveBeenCalledWith(jobId, 'a1');
      expect(queue.requeue).not.toHaveBeenCalled();
      expect(onAckTimeout).not.toHaveBeenCalled();
      expect(registry.get('a1')).toBeDefined();
    });

    it('the ack sweep leaves a row alone once its ack has landed', async () => {
      registry.register('a1', mockWs(), ['linux']);
      const queue = mockQueue();
      (queue.listExpiredAckDeadlines as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'job-s', runId: 'run-s', agentId: 'a1' },
      ]);
      (queue.requeueIfAwaitingAck as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const onAckTimeout = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        onAckTimeout,
      });

      const count = await dispatcher.sweepExpiredAckDeadlines();

      expect(count).toBe(0);
      expect(queue.requeue).not.toHaveBeenCalled();
      expect(onAckTimeout).not.toHaveBeenCalled();
      expect(registry.get('a1')).toBeDefined();
    });
  });

  describe('recovery expiry', () => {
    it('does not fail a job that was reclaimed before the recovery timer fired', async () => {
      // `markFailedIfRecovering` is conditional, so the DB row is safe — but
      // `onJobFailedPermanently` fails `execution_jobs` and cancels the job's
      // steps unconditionally. Gating on the DB's verdict is what stops a
      // reclaimed, running job from being failed out from under its agent.
      vi.useFakeTimers();
      const queue = mockQueue();
      (queue.markFailedIfRecovering as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const onJobFailedPermanently = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        onJobFailedPermanently,
      });

      await dispatcher.startRecoveryTimer('job-rec', 'a1', 'run-rec');
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(queue.markFailedIfRecovering).toHaveBeenCalledWith('job-rec', expect.any(String));
      expect(onJobFailedPermanently).not.toHaveBeenCalled();
      dispatcher.stopRecoveryTimers();
    });

    it('fails the job when the recovery row was still recovering', async () => {
      vi.useFakeTimers();
      const queue = mockQueue();
      (queue.markFailedIfRecovering as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const onJobFailedPermanently = vi.fn();
      const dispatcher = new Dispatcher({
        registry,
        queue,
        metrics: mockMetrics(),
        onDispatch: vi.fn(),
        onJobFailedPermanently,
      });

      await dispatcher.startRecoveryTimer('job-rec', 'a1', 'run-rec');
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(onJobFailedPermanently).toHaveBeenCalledWith(
        'a1',
        'job-rec',
        'run-rec',
        expect.any(String),
      );
      dispatcher.stopRecoveryTimers();
    });
  });
});

describe('containerSpawnFor', () => {
  it('offers a spawn for a job that names a finalized image', () => {
    expect(containerSpawnFor({ container: 'python:3.12' })).toEqual({ image: 'python:3.12' });
    expect(containerSpawnFor({ container: { image: 'python:3.12' } })).toEqual({
      image: 'python:3.12',
    });
  });

  it('carries the orchestrator-resolved authconfig through', () => {
    expect(
      containerSpawnFor({
        container: { image: 'reg:5000/a/b:1' },
        containerRegistryAuth: { username: 'u', password: 'p', serveraddress: 'reg:5000' },
      }),
    ).toEqual({
      image: 'reg:5000/a/b:1',
      authconfig: { username: 'u', password: 'p', serveraddress: 'reg:5000' },
    });
  });

  it('offers NO spawn for a job that builds its image from a dockerfile', () => {
    // This is what routes a dockerfile job to the nesting topology: the image
    // does not exist until an agent has cloned and built it, so the scaler must
    // not try to boot an agent from it.
    expect(containerSpawnFor({ container: { dockerfile: '.kici/ci.Dockerfile' } })).toBeUndefined();
  });

  it('offers no spawn for a job with no container at all', () => {
    expect(containerSpawnFor({})).toBeUndefined();
    expect(containerSpawnFor(undefined)).toBeUndefined();
  });
});

describe('Dispatcher — a refused dispatch', () => {
  const REASON = 'no clone credentials for the source repository';

  function setup(refuse: boolean, dequeueJobs: QueuedJob[] = [], opts: { peers?: boolean } = {}) {
    const registry = new AgentRegistry();
    registry.register('agent-1', mockWs(), ['linux']);
    const queue = mockQueue({ dequeueJobs });
    const deferUnopenable = vi.mocked(queue.deferUnopenable);
    const metrics = mockMetrics();
    const onJobFailedPermanently = vi.fn();
    const onDispatch = vi.fn(async () => (refuse ? { refused: REASON } : undefined));
    const dispatcher = new Dispatcher({
      registry,
      queue,
      metrics,
      onDispatch,
      onJobFailedPermanently,
      ...(opts.peers !== undefined && { hasPeerCoordinators: () => opts.peers! }),
    });
    return {
      dispatcher,
      registry,
      queue,
      metrics,
      onJobFailedPermanently,
      onDispatch,
      deferUnopenable,
    };
  }

  it('fails a directly dispatched job the callback refused, instead of awaiting its ack', async () => {
    // fails-when: a refused job keeps its agent slot and an ack deadline for a message never sent
    const { dispatcher, registry, queue, metrics, onJobFailedPermanently } = setup(true);

    const result = await dispatcher.dispatch(makeJobInput());

    expect(result.status).toBe('dispatched');
    const jobId = (result as { jobId: string }).jobId;
    expect(queue.markFailed).toHaveBeenCalledWith(jobId, REASON);
    expect(onJobFailedPermanently).toHaveBeenCalledWith('agent-1', jobId, 'run-1', REASON);
    expect(registry.get('agent-1')!.activeJobs).toBe(0);
    expect(queue.setAckDeadline).not.toHaveBeenCalled();
    expect(metrics.incJobsDispatched).not.toHaveBeenCalledWith('dispatched');
  });

  it('fails a queue-drained job the callback refused', async () => {
    const job = makeQueuedJob({ id: 'queued-refused' });
    const { dispatcher, queue, onJobFailedPermanently } = setup(true, [job]);

    await dispatcher.onAgentAvailable('agent-1');

    expect(queue.markFailed).toHaveBeenCalledWith('queued-refused', REASON);
    expect(onJobFailedPermanently).toHaveBeenCalledWith(
      'agent-1',
      'queued-refused',
      'run-1',
      REASON,
    );
    expect(queue.setAckDeadline).not.toHaveBeenCalled();
  });

  describe('a queue-drained job whose sealed secrets this coordinator cannot open', () => {
    const UNSEALED = new JobSecretsUnsealError('run-1', 'bad key').message;

    it('puts the job back pending for a peer coordinator, unsent and not failed', async () => {
      const job = makeQueuedJob({ id: 'queued-unsealed', secretsUnavailable: UNSEALED });
      const { dispatcher, registry, queue, onJobFailedPermanently, deferUnopenable } = setup(
        false,
        [job],
        { peers: true },
      );

      await dispatcher.onAgentAvailable('agent-1');

      // fails-when: a key mismatch during a rolling rotation fails the job permanently
      expect(queue.requeue).toHaveBeenCalledWith('queued-unsealed', {
        countAttempt: true,
        provisioningError: UNSEALED,
      });
      expect(deferUnopenable).toHaveBeenCalledWith('queued-unsealed');
      // The deferral is armed before the row returns to pending.
      // fails-when: the requeue runs first, so a concurrent drain can re-claim the job inside its back-off
      expect(deferUnopenable.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(queue.requeue).mock.invocationCallOrder[0],
      );
      expect(queue.markFailed).not.toHaveBeenCalled();
      expect(onJobFailedPermanently).not.toHaveBeenCalled();
      expect(queue.setAckDeadline).not.toHaveBeenCalled();
      expect(registry.get('agent-1')!.activeJobs).toBe(0);
    });

    it('fails the job at once when no peer coordinator is connected', async () => {
      const job = makeQueuedJob({ id: 'queued-unsealed', secretsUnavailable: UNSEALED });
      const { dispatcher, queue, onJobFailedPermanently, onDispatch } = setup(false, [job]);

      await dispatcher.onAgentAvailable('agent-1');

      // fails-when: a single node puts back a job no coordinator will ever open
      expect(queue.requeue).not.toHaveBeenCalled();
      expect(queue.markFailed).toHaveBeenCalledWith('queued-unsealed', UNSEALED);
      expect(onJobFailedPermanently).toHaveBeenCalledWith(
        'agent-1',
        'queued-unsealed',
        'run-1',
        UNSEALED,
      );
      expect(onDispatch).not.toHaveBeenCalled();
    });

    it('fails the job once its dispatch attempts run out', async () => {
      const job = makeQueuedJob({ id: 'queued-unsealed', secretsUnavailable: UNSEALED });
      const { dispatcher, queue, onJobFailedPermanently } = setup(false, [job], { peers: true });
      vi.mocked(queue.requeue).mockResolvedValueOnce(MAX_DISPATCH_ATTEMPTS);

      await dispatcher.onAgentAvailable('agent-1');

      // breaks-if-wrong: a job no coordinator can open must not stay pending forever
      expect(queue.markFailed).toHaveBeenCalledWith(
        'queued-unsealed',
        expect.stringContaining(UNSEALED),
      );
      expect(onJobFailedPermanently).toHaveBeenCalledWith(
        'agent-1',
        'queued-unsealed',
        'run-1',
        expect.stringContaining('finish the key rotation on every coordinator'),
      );
    });
  });

  it('sends a job the callback accepted and arms its ack deadline', async () => {
    // breaks-if-wrong: a callback that returns nothing must still count as sent
    const { dispatcher, registry, queue, metrics, onJobFailedPermanently } = setup(false);

    await dispatcher.dispatch(makeJobInput());

    expect(queue.markFailed).not.toHaveBeenCalled();
    expect(onJobFailedPermanently).not.toHaveBeenCalled();
    expect(registry.get('agent-1')!.activeJobs).toBe(1);
    expect(queue.setAckDeadline).toHaveBeenCalledTimes(1);
    expect(metrics.incJobsDispatched).toHaveBeenCalledWith('dispatched');
  });
});

describe('Dispatcher — the requeue redispatch and a job inside its sealed-secrets back-off', () => {
  const UNSEALED = new JobSecretsUnsealError('run-1', 'bad key').message;

  function setup(deferred: boolean, extra: Partial<QueuedJob> = {}) {
    const registry = new AgentRegistry();
    registry.register('a1', mockWs(), ['linux']);
    const fullJob = makeQueuedJob({
      id: 'job-1',
      status: DispatchQueueStatus.Pending,
      runsOnLabels: ['linux'],
      ...extra,
    });
    const queue = {
      ...mockQueue(),
      requeue: vi.fn(async () => 1),
      getFullJobById: vi.fn(async () => fullJob),
      getDepth: vi.fn(async () => 0),
      isDeferredUnopenable: vi.fn(() => deferred),
    } as unknown as JobQueue;
    const onNoMatchingAgent = vi.fn().mockResolvedValue({ action: 'spawning' });
    const dispatcher = new Dispatcher({
      registry,
      queue,
      metrics: mockMetrics(),
      onDispatch: vi.fn(),
      onNoMatchingAgent,
      hasPeerCoordinators: () => true,
    });
    registry.incrementActiveJobs('a1');
    dispatcher.restoreJobForAgent('a1', 'job-1');
    return { dispatcher, queue, onNoMatchingAgent };
  }

  it('claims a requeued job it cannot open and puts it back, instead of scaling for it', async () => {
    const { dispatcher, queue, onNoMatchingAgent } = setup(false, {
      secretsUnavailable: UNSEALED,
      jobConfig: { container: { image: 'registry.example.com/team/private:1' } },
    });
    // The only agent holds its one slot, so an opened job would go to the scaler.
    await (dispatcher as unknown as { redispatch(jobId: string): Promise<void> }).redispatch(
      'job-1',
    );

    // fails-when: the redispatch spawns the private image without the sealed registry credentials
    expect(onNoMatchingAgent).not.toHaveBeenCalled();
    expect(queue.claimUnopenableById).toHaveBeenCalledWith('job-1');
    expect(queue.requeue).toHaveBeenCalledWith('job-1', {
      countAttempt: true,
      provisioningError: UNSEALED,
    });
  });

  it('still scales for a requeued job it can open when no agent is free', async () => {
    const { dispatcher, queue, onNoMatchingAgent } = setup(false, {
      jobConfig: { container: { image: 'registry.example.com/team/private:1' } },
    });

    await (dispatcher as unknown as { redispatch(jobId: string): Promise<void> }).redispatch(
      'job-1',
    );

    // breaks-if-wrong: a requeued job whose secrets opened is scaled for with its image
    expect(onNoMatchingAgent).toHaveBeenCalledTimes(1);
    expect(onNoMatchingAgent.mock.calls[0][6]).toEqual({
      image: 'registry.example.com/team/private:1',
    });
    expect(queue.claimUnopenableById).not.toHaveBeenCalled();
  });

  it('does not re-offer a job this coordinator put back, inside its back-off', async () => {
    const { dispatcher, queue } = setup(true);
    await dispatcher.onJobRejected('a1', 'job-1', JobRejectReason.enum.draining);
    // fails-when: the redispatch re-claims a job this coordinator just put back for a peer
    expect(queue.dequeueById).not.toHaveBeenCalled();
  });

  it('re-offers the job once its back-off has lapsed', async () => {
    const { dispatcher, queue } = setup(false);
    await dispatcher.onJobRejected('a1', 'job-1', JobRejectReason.enum.draining);
    // breaks-if-wrong: a job past its back-off is offered like any other, so it can still fail
    expect(queue.dequeueById).toHaveBeenCalledWith('job-1', ['linux'], [], 'a1');
  });
});
