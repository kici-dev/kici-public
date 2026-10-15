/**
 * Ephemeral JobQueue for worker nodes, which get jobs from the coordinator over
 * P2P rather than a database queue, so the dispatcher runs unchanged on workers.
 * A job enqueued with no agent available waits here until a matching agent connects.
 */

import { randomUUID } from 'node:crypto';
import {
  canonicalizeLabels,
  canonicalizeLabelSet,
  canonicalizeMatcher,
  matcherSatisfiedBy,
} from '@kici-dev/engine';
import {
  DispatchQueueStatus,
  resourcesFromJobConfig,
  type QueuedJobInput,
  type QueuedJob,
} from '../queue/job-queue.js';

/**
 * Dispatch eligibility: subset (`agent ⊇ runsOn`), exclusion (no `excludeLabels`
 * in `agentLabels`), and the mandatory-labels gate (`runsOn ⊇ agentMandatoryLabels`).
 * Mirrors the SQL predicates of `JobQueue.dequeueForLabels` / `dequeueById`, so
 * the worker enforces the coordinator's gate.
 */
function matchesGate(
  job: QueuedJob,
  agentLabels: string[],
  agentMandatoryLabels: string[],
): boolean {
  // `enqueue` already folded the job's selectors; fold the agent's side so the
  // verdict matches the coordinator's DB queue.
  const labels = canonicalizeLabels(agentLabels);
  const gate = canonicalizeLabels(agentMandatoryLabels);
  const labelsMatch =
    job.runsOnLabels.length === 0 || job.runsOnLabels.every((l) => labels.includes(l));
  if (!labelsMatch) return false;
  if (job.excludeLabels.some((l) => labels.includes(l))) return false;
  if (gate.length > 0) {
    const runsOnSet = new Set(job.runsOnLabels);
    if (!gate.every((m) => runsOnSet.has(m))) return false;
  }
  // JS regex post-filter (single matching authority): every runsOn pattern must
  // match some agent label and no exclude pattern may match any.
  const labelSet = new Set(labels);
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
  /**
   * Jobs the owning coordinator stopped (a cancel), or this worker gave back after
   * its spawn retries ran out. Never claimed, listed or re-pended — the counterpart
   * of the database queue's stopped-run guard. The mark goes with the job's entry.
   */
  private readonly stopped = new Set<string>();

  /** Stop-mark every job of `runId` (or just `jobId`), pending or dispatched. Synchronous. */
  stop(runId: string, jobId?: string): { pending: string[]; dispatched: string[] } {
    const matches = (job: QueuedJob) =>
      job.runId === runId && (jobId === undefined || job.id === jobId);
    const pending = [...this.jobs.values()].filter(matches).map((j) => j.id);
    const dispatched = [...this.dispatched.values()].filter(matches).map((j) => j.id);
    for (const id of [...pending, ...dispatched]) this.stopped.add(id);
    return { pending, dispatched };
  }

  /** True while the job waits in this queue and has not been stopped. */
  isPending(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    return job?.status === DispatchQueueStatus.Pending && !this.stopped.has(jobId);
  }

  /**
   * Parity with the database queue, whose dispatcher calls this after a `null`
   * requeue. `requeue` already dropped a stopped job, so nothing is left to settle.
   */
  async settleClaimOfStoppedRun(_jobId: string, _runId: string): Promise<boolean> {
    return false;
  }

  async enqueue(input: QueuedJobInput): Promise<string> {
    const id = input.jobId ?? randomUUID();
    // Materialize `resources` as `JobQueue.rowToQueuedJob` does (the top-level
    // field mirrors `jobConfig.resources`). Without it a drained job declares
    // nothing: `canAgentRunJob` admits any warm agent, and the scaler re-drive
    // spawns at the label-set default.
    this.jobs.set(id, {
      id,
      resources: input.resources ?? resourcesFromJobConfig(input.jobConfig),
      runId: input.runId,
      workflowName: input.workflowName,
      jobName: input.jobName,
      // Folded at write, as `JobQueue.rowToQueuedJob` folds at read: this is the
      // in-memory queue's one ingress into the canonical matching domain.
      runsOnLabels: canonicalizeLabels(input.runsOnLabels),
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
      sourceTarDigest: input.sourceTarDigest,
      depsUrl: input.depsUrl,
      depsHash: input.depsHash,
      requestId: input.requestId,
      excludeLabels: canonicalizeLabels(input.excludeLabels ?? []),
      runsOnPatterns: (input.runsOnPatterns ?? []).map(canonicalizeMatcher),
      excludePatterns: (input.excludePatterns ?? []).map(canonicalizeMatcher),
      routingKey: input.routingKey,
      pinnedAgentId: input.pinnedAgentId,
    });
    return id;
  }

  /**
   * Honors a pre-allocated jobId (cluster reroute) or generates one. No unique-key
   * constraint here, so an insert is always new.
   */
  async insertDispatched(
    input: QueuedJobInput,
    _agentId: string,
  ): Promise<{ id: string; inserted: boolean }> {
    return { id: input.jobId ?? randomUUID(), inserted: true };
  }

  /**
   * First pending job matching the labels. `agentMandatoryLabels` mirrors the
   * `JobQueue.dequeueForLabels` gate; empty (static / non-scaler agents) passes.
   */
  async dequeueForLabels(
    agentLabels: string[],
    agentMandatoryLabels: string[] = [],
    _agentId?: string,
    canServe?: (job: QueuedJob) => boolean,
  ): Promise<QueuedJob | null> {
    for (const [id, job] of this.jobs) {
      if (job.status !== DispatchQueueStatus.Pending || this.stopped.has(id)) continue;
      if (!matchesGate(job, agentLabels, agentMandatoryLabels)) continue;
      // As in the DB queue: labels cannot express whether a scaler agent may run it.
      if (canServe && !canServe(job)) continue;
      job.status = DispatchQueueStatus.Dispatched;
      this.jobs.delete(id);
      this.dispatched.set(id, job);
      return job;
    }
    return null;
  }

  /**
   * Mirrors `JobQueue.dequeueById`, which `Dispatcher.dispatchBoundJob()` calls
   * when a scaler agent registers for the jobId it was spawned for. Null when the
   * job is missing, not Pending, or fails {@link matchesGate}.
   */
  async dequeueById(
    jobId: string,
    agentLabels: string[],
    agentMandatoryLabels: string[] = [],
  ): Promise<QueuedJob | null> {
    const job = this.jobs.get(jobId);
    if (!job || this.stopped.has(jobId)) return null;
    if (job.status !== DispatchQueueStatus.Pending) return null;
    if (!matchesGate(job, agentLabels, agentMandatoryLabels)) return null;
    job.status = DispatchQueueStatus.Dispatched;
    this.jobs.delete(jobId);
    this.dispatched.set(jobId, job);
    return job;
  }

  /**
   * Oldest pending job pinned to the agent; mirrors `JobQueue.dequeueByPinnedAgent`
   * (host-fanout children drain before the label drain). A pinned job skips the
   * label-subset gate; only the JS regex post-filter applies.
   *
   * Workers do not pin jobs, so this returns null in practice and
   * `onAgentAvailable` falls back to `dequeueForLabels`. It must exist:
   * `Dispatcher.onAgentAvailable` calls it unconditionally, and a missing method
   * is an unhandled `TypeError` that crashes the worker.
   */
  async dequeueByPinnedAgent(agentId: string, agentLabels?: string[]): Promise<QueuedJob | null> {
    for (const [id, job] of this.jobs) {
      if (job.status !== DispatchQueueStatus.Pending || this.stopped.has(id)) continue;
      if (job.pinnedAgentId !== agentId) continue;
      if (agentLabels) {
        const labelSet = canonicalizeLabelSet(agentLabels);
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

  async getDepth(): Promise<number> {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === DispatchQueueStatus.Pending && !this.stopped.has(job.id)) count++;
    }
    return count;
  }

  /** No-op — the job is already tracked in `dispatched` from dequeue. */
  async markDispatched(_jobId: string, _agentId: string): Promise<void> {}

  async markFailed(jobId: string, _reason: string): Promise<void> {
    this.dispatched.delete(jobId);
    this.jobs.delete(jobId);
    this.attempts.delete(jobId);
    this.stopped.delete(jobId);
  }

  async markCompleted(jobId: string): Promise<void> {
    this.dispatched.delete(jobId);
    this.attempts.delete(jobId);
    this.stopped.delete(jobId);
  }

  async markRecovering(_jobId: string): Promise<void> {}

  /**
   * No-op: the worker's ack deadline lives in its in-memory timer; HA-safe
   * persistence belongs to the coordinator's DB queue.
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
   * Mirrors `JobQueue.requeue`: re-pend a dispatched job, bumping attempts unless
   * `countAttempt` is false. Returns the attempt count, or null when the job is not
   * dispatched or is stopped (a stopped job is dropped instead).
   */
  async requeue(jobId: string, opts: { countAttempt?: boolean } = {}): Promise<number | null> {
    const job = this.dispatched.get(jobId);
    if (!job) return null;
    if (this.stopped.has(jobId)) {
      this.dispatched.delete(jobId);
      this.jobs.delete(jobId);
      this.attempts.delete(jobId);
      this.stopped.delete(jobId);
      return null;
    }
    this.dispatched.delete(jobId);
    job.status = DispatchQueueStatus.Pending;
    this.jobs.set(jobId, job);
    const count = (this.attempts.get(jobId) ?? 0) + (opts.countAttempt === false ? 0 : 1);
    this.attempts.set(jobId, count);
    return count;
  }

  /**
   * `JobQueue.isDeferredUnopenable`'s sealed-secrets back-off, which the requeue
   * redispatch asks every queue. Worker jobs are never sealed, so never deferred.
   */
  isDeferredUnopenable(_jobId: string): boolean {
    return false;
  }

  /** Pending or dispatched. */
  async getFullJobById(jobId: string): Promise<QueuedJob | null> {
    return this.jobs.get(jobId) ?? this.dispatched.get(jobId) ?? null;
  }

  async getPendingJobs(): Promise<QueuedJob[]> {
    return [...this.jobs.values()].filter(
      (j) => j.status === DispatchQueueStatus.Pending && !this.stopped.has(j.id),
    );
  }

  /**
   * Twin of `JobQueue.listPending`: oldest first (insertion order = `created_at
   * ASC`), capped at `limit`. `retryPendingScaleRequests` reads it on every worker
   * whose scaler frees a slot; `worker-core` wires that hook as the coordinator does.
   */
  async listPending(limit: number): Promise<QueuedJob[]> {
    return (await this.getPendingJobs()).slice(0, Math.max(0, limit));
  }

  async getDispatchedJobIdsByRunId(_runId: string): Promise<string[]> {
    return [];
  }

  /** Pending or dispatched. */
  async getJobById(
    jobId: string,
  ): Promise<{ id: string; runId: string; status: DispatchQueueStatus } | null> {
    const job = this.jobs.get(jobId) ?? this.dispatched.get(jobId);
    return job ? { id: job.id, runId: job.runId, status: job.status as DispatchQueueStatus } : null;
  }

  async markFailedIfRecovering(_jobId: string, _reason: string): Promise<boolean> {
    return false;
  }

  async markDispatchedIfRecovering(_jobId: string, _agentId: string): Promise<boolean> {
    return false;
  }

  async getJobsByStatus(
    _status: DispatchQueueStatus,
  ): Promise<
    Array<{ id: string; runId: string; status: DispatchQueueStatus; agentId: string | null }>
  > {
    return [];
  }

  async markExpired(): Promise<number> {
    return 0;
  }
}
