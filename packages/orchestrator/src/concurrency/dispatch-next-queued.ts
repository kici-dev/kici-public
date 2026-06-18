/**
 * Slot-release dispatch helpers for the long-poll concurrency protocol.
 *
 * When a concurrency-group slot frees (run completed, run cancelled, run
 * superseded), the orchestrator picks the FIFO-oldest queued row and wakes up
 * the agent that's parked on its second `waitForConcurrencyAck` call. The
 * agent then continues with normal step execution against the same WS
 * connection it received the original dispatch on.
 *
 * If the in-memory waiter is missing (orchestrator restart, agent already
 * disconnected), the dequeued DB row is marked completed so the slot doesn't
 * get permanently stuck on a phantom holder.
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '@kici-dev/shared';
import type { AgentRegistry } from '../agent/registry.js';
import type { ConcurrencyGroupTracker } from './group-tracker.js';
import type { ConcurrencyQueueManager } from './queue-manager.js';
import type { ConcurrencyWaiters } from './waiters.js';

const logger = createLogger({ prefix: 'concurrency-dispatch' });

export interface DispatchNextQueuedDeps {
  /** In-memory tracker — kept in sync with the DB on dequeue. */
  tracker: ConcurrencyGroupTracker;
  /** DB-backed queue manager. */
  queueManager: ConcurrencyQueueManager;
  /** Agent registry for finding the waiter's WS. */
  registry: AgentRegistry;
  /** In-memory waiter map. */
  waiters: ConcurrencyWaiters;
  /**
   * Default max for `acquireSlot` when re-syncing the in-memory tracker after
   * a dequeue. The runtime concurrency config (per-workflow `max`) is not
   * available at slot-release time; the dequeued waiter has already been
   * accounted for under that policy when it was originally enqueued, so any
   * value `>= 1` is safe here. We pass 1 because the v1 contract documents
   * single-slot semantics (max>1 is out of scope).
   */
  trackerMaxFallback?: number;
}

/**
 * Try to dequeue the next queued entry for `(group, routingKey)` and notify
 * the waiting agent's WS with `concurrency.ack { action: 'proceed' }`.
 *
 * No-op if the queue is empty. When a dequeued waiter is missing or its
 * agent is gone (orphaned row, agent disconnected), the helper LOOPS to the
 * next queued row instead of stopping — otherwise a single orphan would
 * permanently mask all live waiters behind it (orphans sort first by
 * `created_at ASC`).
 *
 * Bounded by a defensive iteration cap so we never accidentally infinite-loop
 * on a queue manager that returns the same row repeatedly.
 */
export async function tryDispatchNextQueued(
  deps: DispatchNextQueuedDeps,
  group: string,
  routingKey: string,
): Promise<void> {
  const { tracker, queueManager, registry, waiters, trackerMaxFallback = 1 } = deps;

  // Cap on how many orphan rows we'll skip per slot release. In practice
  // production queues stay short; this cap mainly protects against bugs in
  // dequeueNext (e.g. a row that fails to flip from queued -> active and
  // gets re-returned).
  const MAX_ITERATIONS = 32;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const next = await queueManager.dequeueNext(group, routingKey);
    if (!next) return;

    // Sync the in-memory tracker so the dequeued run holds the slot the
    // releaser just freed (otherwise the next concurrency.report would see
    // an empty group and proceed unconditionally).
    tracker.acquireSlot(group, routingKey, next.runId, { max: trackerMaxFallback });

    const waiter = waiters.popByRunId(group, routingKey, next.runId);
    if (!waiter) {
      // The DB row was queued but no in-memory waiter exists. Either the
      // orchestrator restarted (dropping all WS connections), or the agent
      // disconnected concurrently with this dispatch. Mark the dequeued row
      // completed and try the next one — otherwise this orphan would
      // permanently block live waiters that came after it.
      await queueManager.markCompleted(next.runId, group, routingKey);
      tracker.releaseSlot(group, routingKey, next.runId);
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
      // The agent that owned this waiter is gone. Same fallback as above.
      await queueManager.markCompleted(next.runId, group, routingKey);
      tracker.releaseSlot(group, routingKey, next.runId);
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
 * Build the agent-disconnect cleanup callback. Drops every waiter owned by
 * the disconnecting agent and marks their `concurrency_groups` rows as
 * cancelled so the queue manager doesn't try to dispatch a phantom run.
 *
 * Returns a no-arg-async closure suitable for passing to the agent WS handler.
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
