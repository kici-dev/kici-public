/**
 * Remove a worker's queued rerouted jobs and stop-mark its dispatched ones.
 *
 * Two triggers reach here: the owning coordinator's `peer.job.cancel`, and this
 * worker exhausting a job's spawn-retry budget. Either way the coordinator owns
 * the job's verdict — it already failed, cancelled or re-dispatched the job — so
 * this reports **nothing** back to it. A worker-side `failed` or `cancelled`
 * terminal would reach the coordinator as a superseded peer's terminal at best,
 * and as a second verdict at worst.
 *
 * A dispatched job keeps its agent, projection and ownership: the agent is
 * running it, and the cancel receiver delivers its `job.cancel`. The stop mark
 * only makes a later requeue drop the job instead of re-pending it.
 */
import type { Dispatcher } from '../agent/dispatcher.js';
import type { InMemoryJobQueue } from './in-memory-job-queue.js';
import type { InMemoryExecutionTracker } from './in-memory-execution-tracker.js';
import type { SpawnRetryBudget } from './spawn-retry-budget.js';

export interface ReleaseDeps {
  queue: Pick<InMemoryJobQueue, 'stop'>;
  dispatcher: Pick<Dispatcher, 'cancelQueuedJob'>;
  executionTracker: Pick<InMemoryExecutionTracker, 'dropJob'>;
  /** jobId → owning coordinator URL. */
  jobOwnership: Map<string, string>;
  budget: Pick<SpawnRetryBudget, 'release'>;
}

/**
 * Stop every matching job of `runId` (or just `jobId`) and remove the pending
 * ones. The stop mark is set synchronously, before the first `await`, so a
 * requeue racing this call drops the job.
 *
 * @returns the ids of the pending jobs removed.
 */
export async function releaseQueuedRerouteJobs(
  deps: ReleaseDeps,
  target: { runId: string; jobId?: string; reason: string },
): Promise<string[]> {
  const { pending } = deps.queue.stop(target.runId, target.jobId);
  for (const id of pending) {
    await deps.dispatcher.cancelQueuedJob(id, target.reason);
    deps.executionTracker.dropJob(target.runId, id);
    deps.jobOwnership.delete(id);
    deps.budget.release(id);
  }
  return pending;
}
