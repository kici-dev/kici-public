/**
 * Slot-release dispatch for the long-poll concurrency protocol. When a group
 * slot frees (run completed, cancelled or superseded), the FIFO-oldest queued
 * row's agent, parked on its second `waitForConcurrencyAck` call, is woken and
 * continues on the WS it got the original dispatch on.
 *
 * A missing in-memory waiter (orchestrator restart, agent disconnected) marks
 * the dequeued row completed so the slot is not stuck on a phantom holder.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@kici-dev/shared';
import type { AgentRegistry } from '../agent/registry.js';
import type { ConcurrencyQueueManager } from './queue-manager.js';
import type { ConcurrencyWaiters } from './waiters.js';

const logger = createLogger({ prefix: 'concurrency-dispatch' });

export interface DispatchNextQueuedDeps {
  /** The DB arbiter. */
  queueManager: ConcurrencyQueueManager;
  registry: AgentRegistry;
  waiters: ConcurrencyWaiters;
}

/**
 * Try to dequeue the next queued entry for `(group, routingKey)` and notify
 * the waiting agent's WS with `job.concurrency.ack { action: 'proceed' }`.
 *
 * No-op on an empty queue. A missing waiter or gone agent LOOPS to the next
 * row; stopping would let one orphan (they sort first by `created_at ASC`)
 * permanently mask every live waiter behind it.
 */
export async function tryDispatchNextQueued(
  deps: DispatchNextQueuedDeps,
  group: string,
  routingKey: string,
): Promise<void> {
  const { queueManager, registry, waiters } = deps;

  // Orphan rows skipped per slot release. Queues stay short; the cap guards
  // against a dequeueNext bug re-returning a row that failed to flip from
  // queued -> active (an infinite loop).
  const MAX_ITERATIONS = 32;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const next = await queueManager.dequeueNext(group, routingKey);
    if (!next) return;

    // `dequeueNext` already flipped the row to `active` in its own
    // transaction, so the dequeued run holds the slot the releaser freed.

    const waiter = waiters.popByRunId(group, routingKey, next.runId);
    if (!waiter) {
      // No in-memory waiter: the orchestrator restarted (dropping every WS) or
      // the agent disconnected concurrently. Complete the orphan and move on.
      await queueManager.markCompleted(next.runId, group, routingKey);
      logger.warn('Queued waiter missing on slot release; cancelling queued run', {
        runId: next.runId,
        jobId: next.jobId,
        group,
        routingKey,
      });
      continue;
    }

    const agent = registry.get(waiter.agentId);
    if (!agent?.ws) {
      // The waiter's agent is gone: same fallback.
      await queueManager.markCompleted(next.runId, group, routingKey);
      logger.warn('Queued waiter agent disconnected; cancelling queued run', {
        runId: waiter.runId,
        jobId: waiter.jobId,
        agentId: waiter.agentId,
        group,
        routingKey,
      });
      continue;
    }

    agent.ws.send(
      JSON.stringify({
        type: 'job.concurrency.ack',
        requestId: randomUUID(),
        action: 'proceed' as const,
        runId: waiter.runId,
        jobId: waiter.jobId,
      }),
    );
    logger.info('Dispatched queued concurrency slot', {
      runId: waiter.runId,
      jobId: waiter.jobId,
      agentId: waiter.agentId,
      group,
      routingKey,
    });
    return;
  }
  logger.warn('tryDispatchNextQueued hit iteration cap; orphan rows still queued?', {
    group,
    routingKey,
    iterations: MAX_ITERATIONS,
  });
}

export interface AgentDisconnectDeps {
  waiters: ConcurrencyWaiters;
  queueManager: ConcurrencyQueueManager;
}

/**
 * Agent-disconnect cleanup: drop the agent's waiters and cancel their
 * `concurrency_groups` rows so the queue manager never dispatches a phantom run.
 *
 * Returns an async `(agentId)` closure suitable for passing to the agent WS handler.
 */
export function buildOnConcurrencyAgentDisconnect(
  deps: AgentDisconnectDeps,
): (agentId: string) => Promise<void> {
  return async (agentId: string) => {
    const dropped = deps.waiters.dropForAgent(agentId);
    for (const entry of dropped) {
      try {
        await deps.queueManager.cancelQueued(entry.runId);
        logger.info('Cancelled queued concurrency run on agent disconnect', {
          agentId,
          runId: entry.runId,
          jobId: entry.jobId,
        });
      } catch (err) {
        logger.warn('Failed to cancel queued run on agent disconnect', {
          agentId,
          runId: entry.runId,
          jobId: entry.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
}
