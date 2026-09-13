import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockInfo } = vi.hoisted(() => ({ mockInfo: vi.fn() }));
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: mockInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  };
});

import { Dispatcher, AgentDrainDecline, type DispatchMetrics } from './dispatcher.js';
import { AgentRegistry } from './registry.js';
import type { JobQueue } from '../queue/job-queue.js';
import { mockWs } from '../__test-helpers__/mock-ws.js';

/**
 * `onAgentAvailable` returns without dispatching on five distinct paths and
 * used to log on none of them. That is what made a pinned, label-matching
 * queued job sitting undrained for a full minute after a host reconnect
 * indistinguishable from an idle orchestrator: the observable behaviour is
 * identical, and staging runs at `info`, so a `debug` line would not have
 * shown it either.
 */
function mockQueue(depth: number): JobQueue {
  return {
    dequeueByPinnedAgent: vi.fn().mockResolvedValue(null),
    dequeueForLabels: vi.fn().mockResolvedValue(null),
    getDepth: vi.fn().mockResolvedValue(depth),
    markDispatched: vi.fn().mockResolvedValue(undefined),
  } as unknown as JobQueue;
}

const metrics = {
  incJobsDispatched: vi.fn(),
  setQueueDepth: vi.fn(),
} as unknown as DispatchMetrics;

/** The `meta` object of every drain-declined line this test's logger saw. */
function declines(): Record<string, unknown>[] {
  return mockInfo.mock.calls
    .filter((c) => String(c[0]).includes('drain declined'))
    .map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

describe('Dispatcher drain-decline reporting', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    mockInfo.mockClear();
    registry = new AgentRegistry();
  });

  afterEach(() => {
    registry.shutdown?.();
  });

  it('names the reason when a registered agent finds no matching job', async () => {
    registry.register('a1', mockWs(), ['linux']);
    const dispatcher = new Dispatcher({
      registry,
      queue: mockQueue(3),
      metrics,
      onDispatch: vi.fn(),
    });

    await dispatcher.onAgentAvailable('a1');

    expect(declines()).toHaveLength(1);
    expect(declines()[0]).toMatchObject({
      agentId: 'a1',
      reason: AgentDrainDecline.NoMatchingJob,
      queueDepth: 3,
    });
  });

  it('names the reason when the agent is not registered', async () => {
    const dispatcher = new Dispatcher({
      registry,
      queue: mockQueue(2),
      metrics,
      onDispatch: vi.fn(),
    });

    await dispatcher.onAgentAvailable('ghost');

    expect(declines()[0]).toMatchObject({ reason: AgentDrainDecline.NotRegistered });
  });

  it('names the reason when the host is reboot-pending', async () => {
    registry.register('a1', mockWs(), ['linux']);
    const dispatcher = new Dispatcher({
      registry,
      queue: mockQueue(1),
      metrics,
      onDispatch: vi.fn(),
      rosterStore: {
        isRebootPending: vi.fn().mockResolvedValue(true),
        clearRebootPending: vi.fn(),
      } as never,
    });

    await dispatcher.onAgentAvailable('a1');

    expect(declines()[0]).toMatchObject({ reason: AgentDrainDecline.RebootPending });
  });

  it('stays quiet when the queue is empty', async () => {
    // The steady state. A line per idle drain would be the loudest thing in
    // the stream and would bury the one occurrence that matters.
    registry.register('a1', mockWs(), ['linux']);
    const dispatcher = new Dispatcher({
      registry,
      queue: mockQueue(0),
      metrics,
      onDispatch: vi.fn(),
    });

    await dispatcher.onAgentAvailable('a1');

    expect(declines()).toHaveLength(0);
  });
});
