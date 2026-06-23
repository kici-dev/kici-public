/**
 * In-memory job queue for worker nodes.
 *
 * Workers receive jobs directly from the coordinator via P2P dispatch,
 * not from a database queue. This implementation satisfies the JobQueue
 * interface with ephemeral in-memory storage, allowing the dispatcher
 * subsystem to work unchanged on workers.
 *
 * Jobs enqueued here (when no agent is immediately available) are stored
 * in memory and dequeued when an agent with matching labels connects.
 */

import { randomUUID } from 'node:crypto';
import { matcherSatisfiedBy } from '@kici-dev/engine';
import { DispatchQueueStatus, type QueuedJobInput, type QueuedJob } from '../queue/job-queue.js';

/**
 * Combined dispatch eligibility check for the in-memory queue:
 *   - subset match (`agent ⊇ runsOn`)
 *   - exclusion (no `excludeLabels` element appears in `agentLabels`)
 *   - mandatory-labels gate (`runsOn ⊇ agentMandatoryLabels`)
 *
 * Mirrors the SQL predicate stack in `JobQueue.dequeueForLabels` /
 * `dequeueById` so worker-side dispatch enforces the same gate the
 * coordinator-side DB queue does.
 */
function matchesGate(
  job: QueuedJob,
  agentLabels: string[],
  agentMandatoryLabels: string[],
): boolean {
  const labelsMatch =
    job.runsOnLabels.length === 0 || job.runsOnLabels.every((l) => agentLabels.includes(l));
  if (!labelsMatch) return false;
  if (job.excludeLabels.some((l) => agentLabels.includes(l))) return false;
  if (agentMandatoryLabels.length > 0) {
    const runsOnSet = new Set(job.runsOnLabels);
    if (!agentMandatoryLabels.every((m) => runsOnSet.has(m))) return false;
  }
  // JS regex post-filter (single matching authority): every runsOn pattern must
  // match some agent label and no exclude pattern may match any.
  const labelSet = new Set(agentLabels);
  if (!job.runsOnPatterns.every((p) => matcherSatisfiedBy(p, labelSet))) return false;
  if (job.excludePatterns.some((p) => matcherSatisfiedBy(p, labelSet))) return false;
  return true;
}

export class InMemoryJobQueue {
  private readonly jobs = new Map<string, QueuedJob>();
  /** Jobs handed to an agent, retained so requeue / lookups can restore them. */
  private readonly dispatched = new Map<string, QueuedJob>();
  /** Per-job re-dispatch counter (parity with dispatch_queue.dispatch_attempts). */
  private readonly attempts = new Map<string, number>();

  /** Enqueue a job in memory and return its ID. */
  async enqueue(input: QueuedJobInput): Promise<string> {
    const id = input.jobId ?? randomUUID();
    this.jobs.set(id, {
      id,
      runId: input.runId,
      workflowName: input.workflowName,
      jobName: input.jobName,
      runsOnLabels: input.runsOnLabels,
      jobConfig: input.jobConfig,
      repoUrl: input.repoUrl,
      ref: input.ref,
      sha: input.sha,
      status: DispatchQueueStatus.Pending,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      deliveryId: input.deliveryId,
      provider: input.provider,
      providerContext: input.providerContext,
      sourceTarUrl: input.sourceTarUrl,
      sourceTarHash: input.sourceTarHash,
      depsUrl: input.depsUrl,
      depsHash: input.depsHash,
      requestId: input.requestId,
      excludeLabels: input.excludeLabels ?? [],
      runsOnPatterns: input.runsOnPatterns ?? [],
      excludePatterns: input.excludePatterns ?? [],
      routingKey: input.routingKey,
      pinnedAgentId: input.pinnedAgentId,
    });
    return id;
  }

  /**
   * Returns a generated UUID for direct-dispatch tracking, or honors the
   * caller's pre-allocated jobId when set (cluster reroute path).
   */
  async insertDispatched(input: QueuedJobInput): Promise<string> {
    return input.jobId ?? randomUUID();
  }

  /**
   * Dequeue the first pending job matching the given labels.
   *
   * `agentMandatoryLabels` mirrors the DB-backed `JobQueue.dequeueForLabels`
   * gate: a job is only dequeued when its `runsOnLabels` includes every
   * label in the gate set. Empty (default) is a no-op for static / non-scaler
   * agents — the gate trivially passes.
   */
  async dequeueForLabels(
    agentLabels: string[],
    agentMandatoryLabels: string[] = [],
  ): Promise<QueuedJob | null> {
    for (const [id, job] of this.jobs) {
      if (job.status !== DispatchQueueStatus.Pending) continue;
      if (!matchesGate(job, agentLabels, agentMandatoryLabels)) continue;
      job.status = DispatchQueueStatus.Dispatched;
      this.jobs.delete(id);
      this.dispatched.set(id, job);
      return job;
    }
    return null;
  }

  /**
   * Dequeue a specific pending job by id, validating that the agent's labels
   * still satisfy the job's runsOn / excludeLabels and the agent's
   * `mandatoryLabels` gate. Mirrors the DB-backed `JobQueue.dequeueById`
   * used by `Dispatcher.dispatchBoundJob()` when a scaler-managed agent
   * registers and the scaler had bound a queued jobId to that agent at
   * spawn time. Returns null if the job is missing, no longer Pending,
   * labels no longer match, or the agent's gate is not satisfied.
   */
  async dequeueById(
    jobId: string,
    agentLabels: string[],
    agentMandatoryLabels: string[] = [],
  ): Promise<QueuedJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.status !== DispatchQueueStatus.Pending) return null;
    if (!matchesGate(job, agentLabels, agentMandatoryLabels)) return null;
    job.status = DispatchQueueStatus.Dispatched;
    this.jobs.delete(jobId);
    this.dispatched.set(jobId, job);
    return job;
  }

  /**
   * Dequeue the oldest pending job pinned to a specific agent. Mirrors the
   * DB-backed `JobQueue.dequeueByPinnedAgent` that `Dispatcher.onAgentAvailable`
   * calls — host-fanout children pinned to THIS agent drain before the generic
   * label drain. Like the DB version, a pinned job relaxes the label-subset
   * gate (the agent is its designated runner) and only the JS regex
   * post-filter is applied.
   *
   * The worker receives jobs via direct P2P dispatch and does not currently
   * pin jobs to agents, so in practice no in-memory job carries a
   * `pinnedAgentId` and this returns null — `onAgentAvailable` then falls back
   * to `dequeueForLabels`. Implementing it (rather than leaving it undefined)
   * is mandatory: `Dispatcher.onAgentAvailable` invokes it unconditionally, so
   * its absence threw `TypeError: this.queue.dequeueByPinnedAgent is not a
   * function` as an unhandled rejection that crashed the worker.
   */
  async dequeueByPinnedAgent(agentId: string, agentLabels?: string[]): Promise<QueuedJob | null> {
    for (const [id, job] of this.jobs) {
      if (job.status !== DispatchQueueStatus.Pending) continue;
      if (job.pinnedAgentId !== agentId) continue;
      if (agentLabels) {
        const labelSet = new Set(agentLabels);
        if (!job.runsOnPatterns.every((p) => matcherSatisfiedBy(p, labelSet))) continue;
        if (job.excludePatterns.some((p) => matcherSatisfiedBy(p, labelSet))) continue;
      }
      job.status = DispatchQueueStatus.Dispatched;
      this.jobs.delete(id);
      this.dispatched.set(id, job);
      return job;
    }
    return null;
  }

  /** Return count of pending jobs. */
  async getDepth(): Promise<number> {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === DispatchQueueStatus.Pending) count++;
    }
    return count;
  }

  /** No-op — the job is already tracked in `dispatched` from dequeue. */
  async markDispatched(_jobId: string, _agentId: string): Promise<void> {}

  /** Drop the dispatched entry — the job reached a terminal state. */
  async markFailed(jobId: string, _reason: string): Promise<void> {
    this.dispatched.delete(jobId);
    this.jobs.delete(jobId);
    this.attempts.delete(jobId);
  }

  /** Drop the dispatched entry — the job completed. */
  async markCompleted(jobId: string): Promise<void> {
    this.dispatched.delete(jobId);
    this.attempts.delete(jobId);
  }

  /** No-op. */
  async markRecovering(_jobId: string): Promise<void> {}

  /**
   * No-op. The worker's dispatch-ack deadline lives entirely in the
   * in-memory timer; HA-safe persistence belongs to the coord's DB-backed
   * queue, not the worker's in-memory queue.
   */
  async setAckDeadline(_jobId: string, _deadline: Date, _agentId: string): Promise<void> {}

  /** No-op (see setAckDeadline). */
  async clearAckDeadline(_jobId: string): Promise<void> {}

  /** Always empty — the worker never rehydrates ack timers from a DB. */
  async getDispatchedAwaitingAck(): Promise<
    Array<{ id: string; runId: string; agentId: string | null; deadline: Date }>
  > {
    return [];
  }

  /** Always empty — the worker is never the leader running the ack sweep. */
  async listExpiredAckDeadlines(
    _now: Date,
  ): Promise<Array<{ id: string; runId: string; agentId: string | null }>> {
    return [];
  }

  /**
   * Return a dispatched job to pending for re-dispatch, bumping its attempt
   * counter. Mirrors the DB-backed `JobQueue.requeue`. Returns the new
   * attempt count, or null when the job is not currently dispatched.
   */
  async requeue(jobId: string): Promise<number | null> {
    const job = this.dispatched.get(jobId);
    if (!job) return null;
    this.dispatched.delete(jobId);
    job.status = DispatchQueueStatus.Pending;
    this.jobs.set(jobId, job);
    const count = (this.attempts.get(jobId) ?? 0) + 1;
    this.attempts.set(jobId, count);
    return count;
  }

  /** Full job lookup across pending and dispatched jobs. */
  async getFullJobById(jobId: string): Promise<QueuedJob | null> {
    return this.jobs.get(jobId) ?? this.dispatched.get(jobId) ?? null;
  }

  /** Return all pending jobs. */
  async getPendingJobs(): Promise<QueuedJob[]> {
    return [...this.jobs.values()].filter((j) => j.status === DispatchQueueStatus.Pending);
  }

  /** Always returns empty array. */
  async getDispatchedJobIdsByRunId(_runId: string): Promise<string[]> {
    return [];
  }

  /** Lookup across pending and dispatched jobs (id / runId / status). */
  async getJobById(
    jobId: string,
  ): Promise<{ id: string; runId: string; status: DispatchQueueStatus } | null> {
    const job = this.jobs.get(jobId) ?? this.dispatched.get(jobId);
    return job ? { id: job.id, runId: job.runId, status: job.status as DispatchQueueStatus } : null;
  }

  /** Always returns false. */
  async markFailedIfRecovering(_jobId: string, _reason: string): Promise<boolean> {
    return false;
  }

  /** Always returns false. */
  async markDispatchedIfRecovering(_jobId: string): Promise<boolean> {
    return false;
  }

  /** Always returns empty array. */
  async getJobsByStatus(
    _status: DispatchQueueStatus,
  ): Promise<Array<{ id: string; runId: string; status: DispatchQueueStatus }>> {
    return [];
  }

  /** No-op — nothing to expire. */
  async markExpired(): Promise<number> {
    return 0;
  }
}
