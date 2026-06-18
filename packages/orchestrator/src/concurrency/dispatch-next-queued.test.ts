/**
 * Unit tests for the slot-release dispatch helpers (`tryDispatchNextQueued`
 * and `buildOnConcurrencyAgentDisconnect`). The helpers are exercised against
 * an in-memory `ConcurrencyWaiters` plus fakes for the queue manager, group
 * tracker, and agent registry — no DB / WS plumbing required.
 */

import { describe, expect, it, vi } from 'vitest';
import { ConcurrencyWaiters } from './waiters.js';
import {
  tryDispatchNextQueued,
  buildOnConcurrencyAgentDisconnect,
} from './dispatch-next-queued.js';
import type { ConcurrencyQueueManager, QueuedJob } from './queue-manager.js';
import type { ConcurrencyGroupTracker } from './group-tracker.js';
import type { AgentRegistry } from '../agent/registry.js';

interface FakeQueueState {
  next?: QueuedJob | null;
  dequeueNext: ReturnType<typeof vi.fn>;
  markCompleted: ReturnType<typeof vi.fn>;
  cancelQueued: ReturnType<typeof vi.fn>;
}

function makeFakeQueueManager(next: QueuedJob | null): FakeQueueState {
  const dequeueNext = vi.fn().mockResolvedValue(next);
  const markCompleted = vi.fn().mockResolvedValue(undefined);
  const cancelQueued = vi.fn().mockResolvedValue(undefined);
  return { next, dequeueNext, markCompleted, cancelQueued };
}

function makeFakeTracker(): ConcurrencyGroupTracker {
  const acquireSlot = vi.fn().mockReturnValue(true);
  const releaseSlot = vi.fn();
  return { acquireSlot, releaseSlot } as unknown as ConcurrencyGroupTracker;
}

function makeFakeRegistry(agentId: string, ws: { send: ReturnType<typeof vi.fn> } | null) {
  return {
    get: vi.fn().mockImplementation((id: string) => {
      if (id !== agentId) return undefined;
      return ws ? { agentId, ws } : undefined;
    }),
  } as unknown as AgentRegistry;
}

const GROUP = 'deploy-main';
const ROUTING = 'org/repo';

describe('tryDispatchNextQueued', () => {
  it('returns silently when the queue is empty', async () => {
    const queueManager = makeFakeQueueManager(null);
    const tracker = makeFakeTracker();
    const waiters = new ConcurrencyWaiters();
    const registry = makeFakeRegistry('agent-x', { send: vi.fn() });

    await tryDispatchNextQueued(
      {
        tracker,
        queueManager: queueManager as unknown as ConcurrencyQueueManager,
        registry,
        waiters,
      },
      GROUP,
      ROUTING,
    );

    expect(queueManager.dequeueNext).toHaveBeenCalledOnce();
    expect(queueManager.markCompleted).not.toHaveBeenCalled();
    expect(tracker.acquireSlot).not.toHaveBeenCalled();
  });

  it('sends `concurrency.ack { proceed }` to the waiting agent on dequeue', async () => {
    const next: QueuedJob = {
      id: 'cg-1',
      groupKey: GROUP,
      routingKey: ROUTING,
      runId: 'run-2',
      jobId: 'job-2',
    };
    const queueManager = makeFakeQueueManager(next);
    const tracker = makeFakeTracker();
    const waiters = new ConcurrencyWaiters();
    waiters.register(GROUP, ROUTING, { runId: 'run-2', jobId: 'job-2', agentId: 'agent-2' });
    const wsSend = vi.fn();
    const registry = makeFakeRegistry('agent-2', { send: wsSend });

    await tryDispatchNextQueued(
      {
        tracker,
        queueManager: queueManager as unknown as ConcurrencyQueueManager,
        registry,
        waiters,
      },
      GROUP,
      ROUTING,
    );

    expect(tracker.acquireSlot).toHaveBeenCalledWith(GROUP, ROUTING, 'run-2', { max: 1 });
    expect(queueManager.markCompleted).not.toHaveBeenCalled(); // happy path doesn't re-complete
    expect(wsSend).toHaveBeenCalledOnce();
    const sent = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(sent.type).toBe('job.concurrency.ack');
    expect(sent.action).toBe('proceed');
    expect(sent.runId).toBe('run-2');
    expect(sent.jobId).toBe('job-2');
    expect(typeof sent.requestId).toBe('string');
    // Waiter consumed.
    expect(waiters.size()).toBe(0);
  });

  it('cancels the dequeued row and STOPS when no waiter and queue empty', async () => {
    const next: QueuedJob = {
      id: 'cg-2',
      groupKey: GROUP,
      routingKey: ROUTING,
      runId: 'orphan-run',
      jobId: 'orphan-job',
    };
    const queueManager = makeFakeQueueManager(next);
    // Second dequeueNext returns null (queue exhausted after the orphan).
    queueManager.dequeueNext.mockResolvedValueOnce(next).mockResolvedValueOnce(null);
    const tracker = makeFakeTracker();
    const waiters = new ConcurrencyWaiters();
    // Note: no waiter registered.
    const registry = makeFakeRegistry('agent-x', { send: vi.fn() });

    await tryDispatchNextQueued(
      {
        tracker,
        queueManager: queueManager as unknown as ConcurrencyQueueManager,
        registry,
        waiters,
      },
      GROUP,
      ROUTING,
    );

    expect(queueManager.markCompleted).toHaveBeenCalledWith('orphan-run', GROUP, ROUTING);
    expect(tracker.releaseSlot).toHaveBeenCalledWith(GROUP, ROUTING, 'orphan-run');
  });

  it('skips orphans and dispatches the first live waiter found', async () => {
    // First dequeue returns an orphan (no waiter), second dequeue returns a
    // live waiter — exercises the loop. This is the real-world scenario when
    // a previous test left a queued row whose agent has long disconnected.
    const orphan: QueuedJob = {
      id: 'cg-orphan',
      groupKey: GROUP,
      routingKey: ROUTING,
      runId: 'orphan-run',
      jobId: 'orphan-job',
    };
    const live: QueuedJob = {
      id: 'cg-live',
      groupKey: GROUP,
      routingKey: ROUTING,
      runId: 'run-live',
      jobId: 'job-live',
    };
    const queueManager = makeFakeQueueManager(null);
    queueManager.dequeueNext
      .mockResolvedValueOnce(orphan)
      .mockResolvedValueOnce(live)
      .mockResolvedValue(null);
    const tracker = makeFakeTracker();
    const waiters = new ConcurrencyWaiters();
    waiters.register(GROUP, ROUTING, {
      runId: 'run-live',
      jobId: 'job-live',
      agentId: 'agent-live',
    });
    const wsSend = vi.fn();
    const registry = makeFakeRegistry('agent-live', { send: wsSend });

    await tryDispatchNextQueued(
      {
        tracker,
        queueManager: queueManager as unknown as ConcurrencyQueueManager,
        registry,
        waiters,
      },
      GROUP,
      ROUTING,
    );

    expect(queueManager.markCompleted).toHaveBeenCalledWith('orphan-run', GROUP, ROUTING);
    expect(wsSend).toHaveBeenCalledOnce();
    const sent = JSON.parse(wsSend.mock.calls[0][0] as string);
    expect(sent.runId).toBe('run-live');
    expect(waiters.size()).toBe(0);
  });

  it('cancels the dequeued row when the waiter agent has disconnected', async () => {
    const next: QueuedJob = {
      id: 'cg-3',
      groupKey: GROUP,
      routingKey: ROUTING,
      runId: 'run-3',
      jobId: 'job-3',
    };
    const queueManager = makeFakeQueueManager(next);
    const tracker = makeFakeTracker();
    const waiters = new ConcurrencyWaiters();
    waiters.register(GROUP, ROUTING, { runId: 'run-3', jobId: 'job-3', agentId: 'gone' });
    // Registry returns undefined for agent 'gone'.
    const registry = makeFakeRegistry('still-here', { send: vi.fn() });

    await tryDispatchNextQueued(
      {
        tracker,
        queueManager: queueManager as unknown as ConcurrencyQueueManager,
        registry,
        waiters,
      },
      GROUP,
      ROUTING,
    );

    expect(queueManager.markCompleted).toHaveBeenCalledWith('run-3', GROUP, ROUTING);
    expect(tracker.releaseSlot).toHaveBeenCalledWith(GROUP, ROUTING, 'run-3');
    // Waiter was removed.
    expect(waiters.size()).toBe(0);
  });

  it('preserves FIFO order across multiple registered waiters', async () => {
    // Agent A registered first, then B. dequeueNext returns whoever the
    // queue manager says is next; the waiters map matches by runId. This
    // test confirms that the helper does not assume the FIFO head — it
    // matches by runId so the DB and in-memory state stay aligned even if
    // the queue manager picks a non-head row (e.g. priority-aware future).
    const queueManager = makeFakeQueueManager({
      id: 'cg-4',
      groupKey: GROUP,
      routingKey: ROUTING,
      runId: 'run-A',
      jobId: 'job-A',
    });
    const tracker = makeFakeTracker();
    const waiters = new ConcurrencyWaiters();
    waiters.register(GROUP, ROUTING, { runId: 'run-A', jobId: 'job-A', agentId: 'agent-A' });
    waiters.register(GROUP, ROUTING, { runId: 'run-B', jobId: 'job-B', agentId: 'agent-B' });
    const wsSendA = vi.fn();
    const wsSendB = vi.fn();
    const registry = {
      get: vi.fn().mockImplementation((id: string) => {
        if (id === 'agent-A') return { agentId: 'agent-A', ws: { send: wsSendA } };
        if (id === 'agent-B') return { agentId: 'agent-B', ws: { send: wsSendB } };
        return undefined;
      }),
    } as unknown as AgentRegistry;

    await tryDispatchNextQueued(
      {
        tracker,
        queueManager: queueManager as unknown as ConcurrencyQueueManager,
        registry,
        waiters,
      },
      GROUP,
      ROUTING,
    );

    expect(wsSendA).toHaveBeenCalledOnce();
    expect(wsSendB).not.toHaveBeenCalled();
    expect(waiters.size()).toBe(1); // run-B still waiting
  });
});

describe('buildOnConcurrencyAgentDisconnect', () => {
  it('drops every waiter owned by the agent and cancels the queued rows', async () => {
    const queueManager = makeFakeQueueManager(null);
    const waiters = new ConcurrencyWaiters();
    waiters.register('g1', 'r1', { runId: 'r-1', jobId: 'j-1', agentId: 'agent-X' });
    waiters.register('g1', 'r1', { runId: 'r-2', jobId: 'j-2', agentId: 'agent-Y' });
    waiters.register('g2', 'r2', { runId: 'r-3', jobId: 'j-3', agentId: 'agent-X' });

    const handler = buildOnConcurrencyAgentDisconnect({
      waiters,
      queueManager: queueManager as unknown as ConcurrencyQueueManager,
    });

    await handler('agent-X');

    expect(queueManager.cancelQueued).toHaveBeenCalledTimes(2);
    expect(queueManager.cancelQueued).toHaveBeenCalledWith('r-1');
    expect(queueManager.cancelQueued).toHaveBeenCalledWith('r-3');
    // Agent-Y's waiter is preserved.
    expect(waiters.size()).toBe(1);
  });

  it('is a no-op when the agent has no waiters', async () => {
    const queueManager = makeFakeQueueManager(null);
    const waiters = new ConcurrencyWaiters();
    waiters.register('g1', 'r1', { runId: 'r-1', jobId: 'j-1', agentId: 'agent-X' });

    const handler = buildOnConcurrencyAgentDisconnect({
      waiters,
      queueManager: queueManager as unknown as ConcurrencyQueueManager,
    });

    await handler('agent-Z');

    expect(queueManager.cancelQueued).not.toHaveBeenCalled();
    expect(waiters.size()).toBe(1);
  });

  it('logs but does not throw when cancelQueued rejects', async () => {
    const queueManager = makeFakeQueueManager(null);
    queueManager.cancelQueued.mockRejectedValueOnce(new Error('db down'));
    const waiters = new ConcurrencyWaiters();
    waiters.register('g1', 'r1', { runId: 'r-1', jobId: 'j-1', agentId: 'agent-X' });
    waiters.register('g1', 'r1', { runId: 'r-2', jobId: 'j-2', agentId: 'agent-X' });

    const handler = buildOnConcurrencyAgentDisconnect({
      waiters,
      queueManager: queueManager as unknown as ConcurrencyQueueManager,
    });

    await expect(handler('agent-X')).resolves.toBeUndefined();
    expect(queueManager.cancelQueued).toHaveBeenCalledTimes(2);
  });
});

describe('ConcurrencyWaiters', () => {
  it('preserves FIFO order via popByRunId', () => {
    const waiters = new ConcurrencyWaiters();
    waiters.register('g', 'r', { runId: 'a', jobId: 'a-j', agentId: 'a-x' });
    waiters.register('g', 'r', { runId: 'b', jobId: 'b-j', agentId: 'b-x' });

    const popped = waiters.popByRunId('g', 'r', 'a');
    expect(popped).toEqual({ runId: 'a', jobId: 'a-j', agentId: 'a-x' });
    expect(waiters.size()).toBe(1);

    const popped2 = waiters.popByRunId('g', 'r', 'a');
    expect(popped2).toBeUndefined();
  });

  it('isolates waiters across different (group, routingKey) scopes', () => {
    const waiters = new ConcurrencyWaiters();
    waiters.register('g1', 'r1', { runId: 'x', jobId: 'x', agentId: 'x' });
    waiters.register('g2', 'r1', { runId: 'x', jobId: 'x', agentId: 'x' });
    waiters.register('g1', 'r2', { runId: 'x', jobId: 'x', agentId: 'x' });

    expect(waiters.size()).toBe(3);
    waiters.popByRunId('g1', 'r1', 'x');
    expect(waiters.size()).toBe(2);
  });

  it('dropForAgent leaves other agents unaffected', () => {
    const waiters = new ConcurrencyWaiters();
    waiters.register('g', 'r', { runId: 'a', jobId: 'a', agentId: 'X' });
    waiters.register('g', 'r', { runId: 'b', jobId: 'b', agentId: 'Y' });
    waiters.register('g', 'r', { runId: 'c', jobId: 'c', agentId: 'X' });

    const dropped = waiters.dropForAgent('X');
    expect(dropped.map((w) => w.runId)).toEqual(['a', 'c']);
    expect(waiters.size()).toBe(1);
  });
});
