import type { AgentRegistry } from './registry.js';
import {
  DispatchQueueStatus,
  MAX_DISPATCH_ATTEMPTS,
  type JobQueue,
  type QueuedJob,
  type QueuedJobInput,
} from '../queue/job-queue.js';
import type { ScaleResult } from '../scaler/types.js';
import type { ResourceRequest } from '@kici-dev/engine';
import { requestContext, createLogger, toErrorMessage } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'dispatcher' });

/**
 * Metrics interface for dispatch operations.
 * Allows the dispatcher to update Prometheus counters without
 * directly importing the metrics module (dependency injection).
 */
export interface DispatchMetrics {
  /** Increment the jobs dispatched counter by status. */
  incJobsDispatched(status: 'dispatched' | 'queued' | 'rejected'): void;
  /** Set the queue depth gauge. */
  setQueueDepth(depth: number): void;
}

/**
 * Result of a dispatch attempt.
 */
type DispatchResult =
  | { status: 'dispatched'; agentId: string; jobId: string }
  | { status: 'queued'; jobId: string }
  | { status: 'queued-no-backend'; jobId: string }
  | { status: 'rejected'; reason: string };

/**
 * Dispatch coordinator connecting the agent registry and job queue.
 *
 * Routes incoming jobs to matching agents based on label requirements,
 * falling back to the persistent queue when no agent is available.
 * Handles agent lifecycle events (connect, disconnect, job completion).
 *
 * The dispatcher does NOT directly access WebSocket connections --
 * it uses the onDispatch callback provided at construction. The caller
 * (app.ts or server.ts) provides an onDispatch that looks up the agent's
 * WS from the registry and sends the job.dispatch message.
 */
export class Dispatcher {
  private readonly registry: AgentRegistry;
  private readonly queue: JobQueue;
  private readonly metrics: DispatchMetrics;
  private readonly onDispatch: (agentId: string, job: QueuedJob) => void | Promise<void>;
  private readonly onNoMatchingAgent?:
    | ((
        labels: string[],
        jobId: string,
        runId: string,
        excludeLabels: string[],
        resources?: ResourceRequest,
      ) => Promise<ScaleResult>)
    | undefined;

  /**
   * Tracks which jobs are dispatched to which agents.
   * Used for marking jobs as failed on agent disconnect.
   */
  private readonly agentJobs = new Map<string, Set<string>>();

  /** Reverse map: jobId -> agentId, for cancel-run lookups. */
  private readonly jobToAgent = new Map<string, string>();

  /**
   * jobId -> runId for currently-tracked jobs. Populated alongside
   * `jobToAgent`/`agentJobs` at dispatch time and cleared with them, so the
   * provenance token relay can resolve a job's runId from the dispatcher's own
   * state (`resolveOwnedJob`) rather than trusting an agent-asserted value.
   */
  private readonly jobRunIds = new Map<string, string>();

  /**
   * Grace window for recently completed jobs.
   * Allows late messages (log.chunk, step.status) to be accepted for a short
   * period after job completion, preventing false ownership violations.
   */
  private readonly completedJobs = new Map<string, { agentId: string; expiresAt: number }>();

  /** Cap on completedJobs map to prevent unbounded growth. */
  private static readonly COMPLETED_JOBS_CAP = 10_000;

  /** Grace window duration in milliseconds (30 seconds). */
  private static readonly GRACE_WINDOW_MS = 30_000;

  /** Interval for cleaning up expired grace window entries (10 seconds). */
  private static readonly GRACE_CLEANUP_INTERVAL_MS = 10_000;

  /** Timer for periodic grace cleanup. */
  private graceCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Max reconnection delay from agent config, used to derive grace period. */
  private readonly maxReconnectDelayMs: number;

  /**
   * Callback fired when a job reaches a permanent dispatch-side failure:
   * recovery window expired, re-dispatch attempts exhausted, or a
   * scaler-managed agent was destroyed mid-execution. The receiver marks
   * the execution-tracker job failed with the given reason.
   */
  private readonly onJobFailedPermanently?:
    | ((agentId: string, jobId: string, runId: string, reason: string) => void)
    | undefined;

  /** Callback when a job enters recovery (starts timer). */
  private readonly onRecoveryStarted?: ((agentId: string, jobId: string) => void) | undefined;

  /** Fallback ack deadline when no getAckTimeoutMs dep is wired (tests). */
  private static readonly DEFAULT_ACK_TIMEOUT_MS = 10_000;

  /**
   * Pending dispatch acknowledgments: armed when a job.dispatch is sent,
   * resolved by job.ack / job.reject / job.status running / disconnect
   * triage. On expiry the dispatch is treated as lost: requeue + disconnect.
   */
  private readonly pendingAcks = new Map<
    string,
    { agentId: string; runId: string; timer: ReturnType<typeof setTimeout> }
  >();

  /**
   * Acks that arrived before their pending-ack entry was armed (the agent
   * answered faster than the orchestrator could resolve the timeout + stamp
   * the deadline). Keyed by jobId -> the agent that acked. Consumed by
   * `armAckDeadline`, which then skips arming.
   */
  private readonly earlyAcks = new Map<string, string>();

  /** Resolve the per-job ack deadline (per-org override / cluster default). */
  private readonly getAckTimeoutMs: (job: QueuedJob) => Promise<number>;

  /** Cancel + disconnect an agent whose dispatch ack deadline expired. */
  private readonly onAckTimeout?:
    | ((agentId: string, jobId: string, runId: string) => void)
    | undefined;

  /**
   * Jobs that have reached agent-side execution (a `job.status: running`
   * arrived). Disconnect triage treats never-started jobs as safely
   * re-dispatchable; started jobs on destroyed agents fail fast.
   */
  private readonly startedJobs = new Set<string>();

  /**
   * Per-job recovery timers for jobs in 'recovering' state.
   * When an agent disconnects with in-flight jobs, each job gets a timer.
   * If the agent reconnects before the timer fires, the timer is cancelled.
   */
  private readonly recoveringJobs = new Map<
    string,
    {
      agentId: string;
      runId: string;
      timer: ReturnType<typeof setTimeout>;
      disconnectedAt: number;
    }
  >();

  /** Grace period = 2x max reconnection delay. */
  private get gracePeriodMs(): number {
    return this.maxReconnectDelayMs * 2;
  }

  constructor(deps: {
    registry: AgentRegistry;
    queue: JobQueue;
    metrics: DispatchMetrics;
    onDispatch: (agentId: string, job: QueuedJob) => void | Promise<void>;
    /** Optional hook called when no agent matches the job's labels.
     *  When set, receives the per-job `resources` so the scaler can apply
     *  per-scaler / per-orchestrator / per-machine caps before spawning. */
    onNoMatchingAgent?: (
      labels: string[],
      jobId: string,
      runId: string,
      excludeLabels: string[],
      resources?: ResourceRequest,
    ) => Promise<ScaleResult>;
    /** Max reconnection delay from agent config (default 60s). Used to derive grace period. */
    maxReconnectDelayMs?: number;
    /** Callback fired when a job is permanently failed before/outside agent execution. */
    onJobFailedPermanently?: (
      agentId: string,
      jobId: string,
      runId: string,
      reason: string,
    ) => void;
    /** Callback when a job enters recovery (starts timer). */
    onRecoveryStarted?: (agentId: string, jobId: string) => void;
    /** Resolve the per-job dispatch-ack deadline (ms). Defaults to 10s. */
    getAckTimeoutMs?: (job: QueuedJob) => Promise<number>;
    /** Cancel + disconnect an agent whose dispatch ack deadline expired. */
    onAckTimeout?: (agentId: string, jobId: string, runId: string) => void;
  }) {
    this.registry = deps.registry;
    this.queue = deps.queue;
    this.metrics = deps.metrics;
    this.onDispatch = deps.onDispatch;
    this.onNoMatchingAgent = deps.onNoMatchingAgent;
    this.maxReconnectDelayMs = deps.maxReconnectDelayMs ?? 60_000;
    this.onJobFailedPermanently = deps.onJobFailedPermanently;
    this.onRecoveryStarted = deps.onRecoveryStarted;
    this.getAckTimeoutMs = deps.getAckTimeoutMs ?? (async () => Dispatcher.DEFAULT_ACK_TIMEOUT_MS);
    this.onAckTimeout = deps.onAckTimeout;
  }

  /**
   * Dispatch a job to a matching agent, or queue it if none available.
   *
   * Flow:
   * 1. Find available agents matching job's runsOnLabels.
   * 2. If agent found: increment activeJobs, call onDispatch, return 'dispatched'.
   * 3. If no agent: enqueue in queue, return 'queued'.
   * 4. If queue full: return 'rejected'.
   */
  async dispatch(job: QueuedJobInput): Promise<DispatchResult> {
    // Host-fanout pin: route only to the pinned agent, or queue (with the pin)
    // until that agent is free/reconnects. Never falls through to another agent.
    if (job.pinnedAgentId) {
      return this.dispatchPinned(job);
    }
    const available = this.registry.findAvailable(
      job.runsOnLabels,
      job.runsOnPatterns ?? [],
      job.excludeLabels ?? [],
      job.excludePatterns ?? [],
    );

    if (available.length > 0) {
      // Pick the least busy agent (already sorted by findAvailable)
      const agent = available[0];

      // Claim the slot before the async insert (same race as onAgentAvailable).
      this.registry.incrementActiveJobs(agent.agentId);
      let jobId: string;
      try {
        // Persist the job in dispatch_queue with status='dispatched' for:
        // - Audit trail of all dispatched jobs
        // - Ability to mark as failed on agent disconnect
        // - State recovery after orchestrator restart
        jobId = await this.queue.insertDispatched(job);
      } catch (err) {
        this.registry.decrementActiveJobs(agent.agentId);
        throw err;
      }

      const queuedJob: QueuedJob = {
        id: jobId,
        runId: job.runId,
        workflowName: job.workflowName,
        jobName: job.jobName,
        runsOnLabels: job.runsOnLabels,
        jobConfig: job.jobConfig,
        repoUrl: job.repoUrl,
        ref: job.ref,
        sha: job.sha,
        status: DispatchQueueStatus.Dispatched,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        deliveryId: job.deliveryId,
        provider: job.provider,
        providerContext: job.providerContext,
        sourceTarUrl: job.sourceTarUrl,
        sourceTarHash: job.sourceTarHash,
        depsUrl: job.depsUrl,
        depsHash: job.depsHash,
        requestId: job.requestId,
        excludeLabels: job.excludeLabels ?? [],
        runsOnPatterns: job.runsOnPatterns ?? [],
        excludePatterns: job.excludePatterns ?? [],
        routingKey: job.routingKey,
        resources: job.resources,
      };

      this.trackJobForAgent(agent.agentId, jobId, queuedJob.runId);
      await this.onDispatch(agent.agentId, queuedJob);
      // Arm the ack deadline only after the dispatch is actually sent, so the
      // deadline doesn't include the secret-merge / token-mint prep above.
      await this.armAckDeadline(agent.agentId, queuedJob);
      this.metrics.incJobsDispatched('dispatched');

      return { status: 'dispatched', agentId: agent.agentId, jobId };
    }

    // No agent available -- enqueue first so we have a stable jobId.
    // The scaler binds this jobId to whatever agent it spawns, so that on
    // agent registration the orchestrator can eagerly dispatch this exact
    // job to that agent (skipping the generic queue drain race that the
    // 5s scaler-managed agent idle timer otherwise wins).
    let jobId: string;
    try {
      jobId = await this.queue.enqueue(job);
      this.metrics.incJobsDispatched('queued');
      await this.updateQueueDepthMetric();
    } catch (err: unknown) {
      const message = toErrorMessage(err);
      if (message === 'queue full') {
        this.metrics.incJobsDispatched('rejected');
        return { status: 'rejected', reason: 'queue full' };
      }
      throw err;
    }

    // Consult scaler with the real queue jobId for binding.
    if (this.onNoMatchingAgent) {
      const scaleResult = await this.onNoMatchingAgent(
        job.runsOnLabels,
        jobId,
        job.runId,
        job.excludeLabels ?? [],
        job.resources,
      );

      if (
        scaleResult.action === 'no-backend' &&
        !this.registry.hasMatchingAgent(
          job.runsOnLabels,
          job.runsOnPatterns ?? [],
          job.excludeLabels ?? [],
          job.excludePatterns ?? [],
        )
      ) {
        // No backend AND no registered agent. Job stays queued (will expire on
        // timeout) but signal queued-no-backend so the coordinator can try peer
        // rerouting while the local entry serves as fallback. Log WHY (required
        // selectors vs every registered agent's labels/capacity) so the outcome
        // is diagnosable without re-running — distinguishes a label/value
        // mismatch from at-capacity from no-agent-connected.
        logger.warn('Job has no matching backend (queued-no-backend)', {
          runId: job.runId,
          jobName: job.jobName,
          requiredLabels: job.runsOnLabels,
          requiredPatterns: (job.runsOnPatterns ?? []).map((p) => JSON.stringify(p)),
          excludeLabels: job.excludeLabels ?? [],
          registeredAgents: this.registry.agentSummaries(),
        });
        return { status: 'queued-no-backend', jobId };
      }
      // 'spawning': scaler bound the job to the agent it's spawning -- agent
      // registration triggers dispatchBoundJob().
      // 'at-capacity' / 'failed': job sits in queue until an existing agent frees up.
      // 'no-backend' with a matching busy agent: same.
    }

    return { status: 'queued', jobId };
  }

  /**
   * Dispatch a host-fanout pinned child. The job targets exactly
   * `job.pinnedAgentId`: if that agent is locally connected, satisfies the
   * runsOn/exclude/mandatory gate, and has capacity, dispatch immediately;
   * otherwise queue it WITH the pin so the pin-aware drain delivers it when the
   * agent frees up or (re)connects. A pinned job never falls through to a
   * different agent.
   */
  private async dispatchPinned(job: QueuedJobInput): Promise<DispatchResult> {
    const agentId = job.pinnedAgentId!;
    const agent = this.registry.get(agentId);
    const dispatchable =
      agent &&
      this.registry.agentSatisfies(
        agent,
        job.runsOnLabels,
        job.runsOnPatterns ?? [],
        job.excludeLabels ?? [],
        job.excludePatterns ?? [],
      ) &&
      agent.activeJobs < agent.maxConcurrency;

    if (dispatchable) {
      this.registry.incrementActiveJobs(agentId);
      let jobId: string;
      try {
        jobId = await this.queue.insertDispatched(job);
      } catch (err) {
        this.registry.decrementActiveJobs(agentId);
        throw err;
      }
      const queuedJob: QueuedJob = {
        id: jobId,
        runId: job.runId,
        workflowName: job.workflowName,
        jobName: job.jobName,
        runsOnLabels: job.runsOnLabels,
        jobConfig: job.jobConfig,
        repoUrl: job.repoUrl,
        ref: job.ref,
        sha: job.sha,
        status: DispatchQueueStatus.Dispatched,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        deliveryId: job.deliveryId,
        provider: job.provider,
        providerContext: job.providerContext,
        sourceTarUrl: job.sourceTarUrl,
        sourceTarHash: job.sourceTarHash,
        depsUrl: job.depsUrl,
        depsHash: job.depsHash,
        requestId: job.requestId,
        excludeLabels: job.excludeLabels ?? [],
        runsOnPatterns: job.runsOnPatterns ?? [],
        excludePatterns: job.excludePatterns ?? [],
        routingKey: job.routingKey,
        resources: job.resources,
        pinnedAgentId: agentId,
      };
      this.trackJobForAgent(agentId, jobId, queuedJob.runId);
      await this.onDispatch(agentId, queuedJob);
      await this.armAckDeadline(agentId, queuedJob);
      this.metrics.incJobsDispatched('dispatched');
      return { status: 'dispatched', agentId, jobId };
    }

    // The pinned agent is absent / busy: queue with the pin and wait. The
    // pin-aware drain (dequeueByPinnedAgent on register / onAgentAvailable)
    // delivers it once the agent is live with capacity.
    logger.info('Pinned job queued with pin (agent not immediately dispatchable)', {
      jobName: job.jobName,
      runId: job.runId,
      pinnedAgentId: agentId,
      agentRegistered: !!agent,
      satisfies: agent
        ? this.registry.agentSatisfies(
            agent,
            job.runsOnLabels,
            job.runsOnPatterns ?? [],
            job.excludeLabels ?? [],
            job.excludePatterns ?? [],
          )
        : false,
      activeJobs: agent?.activeJobs,
      maxConcurrency: agent?.maxConcurrency,
    });
    let jobId: string;
    try {
      jobId = await this.queue.enqueue(job);
      this.metrics.incJobsDispatched('queued');
      await this.updateQueueDepthMetric();
    } catch (err: unknown) {
      if (toErrorMessage(err) === 'queue full') {
        this.metrics.incJobsDispatched('rejected');
        return { status: 'rejected', reason: 'queue full' };
      }
      throw err;
    }
    return { status: 'queued', jobId };
  }

  /**
   * Eagerly dispatch a specific bound job to a freshly-registered
   * scaler-managed agent.
   *
   * Called by the agent-handler immediately after a scaler-managed agent
   * registers, when the scaler had bound a queued jobId to that agent at
   * spawn time. Atomically claims the job from the queue (validating it's
   * still pending and the agent's labels still satisfy it), marks it
   * dispatched, and sends it to the agent.
   *
   * Returns true if dispatched, false if the bound job was already claimed
   * elsewhere, expired, or the agent isn't registered. The caller falls
   * back to the generic onAgentAvailable() drain in either case.
   */
  async dispatchBoundJob(agentId: string, jobId: string): Promise<boolean> {
    const agent = this.registry.get(agentId);
    if (!agent) return false;
    if (agent.activeJobs >= agent.maxConcurrency) return false;

    // Claim the slot before the async dequeue (same race as onAgentAvailable).
    this.registry.incrementActiveJobs(agentId);
    let job: QueuedJob | null = null;
    try {
      job = await this.queue.dequeueById(jobId, [...agent.labels], [...agent.mandatoryLabels]);
    } finally {
      if (!job) this.registry.decrementActiveJobs(agentId);
    }
    if (!job) return false;

    await this.queue.markDispatched(job.id, agentId);
    this.trackJobForAgent(agentId, job.id, job.runId);

    if (job.requestId) {
      await requestContext.run({ requestId: job.requestId, runId: job.runId }, () =>
        this.onDispatch(agentId, job),
      );
    } else {
      await this.onDispatch(agentId, job);
    }
    await this.armAckDeadline(agentId, job);
    this.metrics.incJobsDispatched('dispatched');
    await this.updateQueueDepthMetric();

    return true;
  }

  /**
   * Try draining the queue for a specific agent.
   * Called when an agent registers or completes a job.
   *
   * Dequeues matching jobs from the queue while the agent has capacity,
   * calling onDispatch for each.
   */
  async onAgentAvailable(agentId: string): Promise<void> {
    const agent = this.registry.get(agentId);
    if (!agent) return;

    const agentLabels = [...agent.labels];
    const agentMandatoryLabels = [...agent.mandatoryLabels];

    if (agent.activeJobs < agent.maxConcurrency) {
      // Claim the slot before the async dequeue. Drain triggers fire
      // concurrently (job completion, agent.status, registration); without
      // the eager claim each racer passes the capacity check and dispatches
      // its own job to the same single-slot agent.
      this.registry.incrementActiveJobs(agentId);
      let job: QueuedJob | null = null;
      try {
        // Pinned host-fanout children for THIS agent drain first (they can only
        // run here), then fall back to the generic label drain (which excludes
        // jobs pinned to a different agent).
        job =
          (await this.queue.dequeueByPinnedAgent(agentId, agentLabels)) ??
          (await this.queue.dequeueForLabels(agentLabels, agentMandatoryLabels, agentId));
      } finally {
        if (!job) this.registry.decrementActiveJobs(agentId);
      }
      if (job) {
        // Mark dispatched in DB
        await this.queue.markDispatched(job.id, agentId);
        this.trackJobForAgent(agentId, job.id, job.runId);

        // Notify caller to send to agent -- restore request context for queue-drained jobs
        if (job.requestId) {
          await requestContext.run({ requestId: job.requestId, runId: job.runId }, () =>
            this.onDispatch(agentId, job),
          );
        } else {
          await this.onDispatch(agentId, job);
        }
        await this.armAckDeadline(agentId, job);
        this.metrics.incJobsDispatched('dispatched');
      }
    }

    await this.updateQueueDepthMetric();
  }

  /** Record that a job began executing on its agent. */
  markJobStarted(jobId: string): void {
    // `job.status: running` doubles as an ack in case the ack itself was lost.
    this.resolvePendingAck(jobId);
    if (this.jobToAgent.has(jobId)) this.startedJobs.add(jobId);
  }

  /**
   * Arm the ack deadline for a just-sent dispatch (timer + persisted row).
   *
   * Resolving the timeout and persisting the deadline both touch the DB, so
   * a fast agent's job.ack can arrive before this method registers its
   * in-memory entry. `earlyAcks` records such an ack so this method skips
   * arming entirely instead of starting a timer that has nothing to resolve
   * it (which would expire a dispatch the agent actually accepted).
   */
  private async armAckDeadline(agentId: string, job: QueuedJob): Promise<void> {
    if (this.consumeEarlyAck(job.id, agentId)) {
      // Agent already acked while we were resolving the timeout. Clear any
      // deadline we may have stamped and don't arm a timer.
      this.queue.clearAckDeadline(job.id).catch((err) => {
        logger.warn('Failed to clear ack deadline', { jobId: job.id, error: toErrorMessage(err) });
      });
      return;
    }
    const timeoutMs = await this.getAckTimeoutMs(job);
    if (this.consumeEarlyAck(job.id, agentId)) {
      this.queue.clearAckDeadline(job.id).catch((err) => {
        logger.warn('Failed to clear ack deadline', { jobId: job.id, error: toErrorMessage(err) });
      });
      return;
    }
    const timer = setTimeout(() => {
      this.handleAckExpiry(agentId, job.id, job.runId).catch((err) => {
        logger.error('Ack expiry handler failed', {
          jobId: job.id,
          agentId,
          error: toErrorMessage(err),
        });
      });
    }, timeoutMs);
    this.pendingAcks.set(job.id, { agentId, runId: job.runId, timer });
    // Persist the deadline without blocking the in-memory arming above, so a
    // fast ack can't race the DB write.
    this.queue.setAckDeadline(job.id, new Date(Date.now() + timeoutMs), agentId).catch((err) => {
      logger.warn('Failed to persist ack deadline', { jobId: job.id, error: toErrorMessage(err) });
    });
  }

  /**
   * Consume a recorded early ack for `jobId` from `agentId`. Returns true if
   * one was pending (and removes it).
   */
  private consumeEarlyAck(jobId: string, agentId: string): boolean {
    if (this.earlyAcks.get(jobId) === agentId) {
      this.earlyAcks.delete(jobId);
      return true;
    }
    return false;
  }

  /** Clear a pending ack (answered or otherwise settled). Idempotent. */
  private resolvePendingAck(jobId: string): void {
    this.earlyAcks.delete(jobId);
    const entry = this.pendingAcks.get(jobId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingAcks.delete(jobId);
    this.queue.clearAckDeadline(jobId).catch((err) => {
      logger.warn('Failed to clear ack deadline', { jobId, error: toErrorMessage(err) });
    });
  }

  /** Handle an explicit dispatch acknowledgment (`job.ack`) from an agent. */
  onJobAcked(agentId: string, jobId: string): void {
    const entry = this.pendingAcks.get(jobId);
    if (!entry) {
      // The ack beat the arming of its deadline (the agent answered faster
      // than the orchestrator resolved the timeout + stamped the DB row).
      // Record it so armAckDeadline can skip arming a timer that would
      // otherwise expire a dispatch the agent actually accepted.
      this.earlyAcks.set(jobId, agentId);
      logger.debug('job.ack arrived before its deadline was armed, recording early ack', {
        agentId,
        jobId,
      });
      return;
    }
    if (entry.agentId !== agentId) {
      logger.warn('job.ack from an agent that does not own the dispatch, ignoring', {
        agentId,
        jobId,
        owner: entry.agentId,
      });
      return;
    }
    this.resolvePendingAck(jobId);
  }

  /**
   * The ack deadline expired: the dispatch is lost. Untrack the job, then
   * remove the unresponsive agent from the registry BEFORE requeueing, so the
   * redispatch cannot land the job back on the very agent we are tearing down.
   * The job is already untracked when the WS close fires, so the disconnect
   * triage finds nothing to double-handle.
   */
  private async handleAckExpiry(agentId: string, jobId: string, runId: string): Promise<void> {
    const entry = this.pendingAcks.get(jobId);
    if (!entry || entry.agentId !== agentId) return; // resolved concurrently
    this.pendingAcks.delete(jobId);
    this.queue.clearAckDeadline(jobId).catch((err) => {
      logger.warn('Failed to clear ack deadline', { jobId, error: toErrorMessage(err) });
    });
    logger.warn('Dispatch ack deadline expired, treating dispatch as lost', {
      agentId,
      jobId,
      runId,
    });
    if (this.registry.get(agentId)) this.registry.decrementActiveJobs(agentId);
    this.untrackJob(agentId, jobId);
    // Tear down the unresponsive agent BEFORE requeueing. The order matters:
    //  1. onAckTimeout closes the WS — it reads the agent entry, so it must
    //     run while the agent is still registered.
    //  2. unregister removes the agent from routing synchronously, so the
    //     redispatch's findAvailable can never re-select it (the WS close
    //     event fires asynchronously and would otherwise leave the agent a
    //     candidate during the synchronous requeue below).
    // The job is already untracked, so the close's disconnect triage finds
    // nothing to double-handle.
    this.onAckTimeout?.(agentId, jobId, runId);
    this.registry.unregister(agentId);
    await this.requeueOrFail(agentId, jobId, 'dispatch ack timeout');
    await this.updateQueueDepthMetric();
  }

  /**
   * Handle an explicit dispatch rejection (`job.reject`) from an agent.
   * Undoes the dispatch accounting and requeues the job for another agent.
   */
  async onJobRejected(agentId: string, jobId: string, reason: string): Promise<void> {
    const owned = this.agentJobs.get(agentId)?.has(jobId) ?? false;
    if (!owned) {
      logger.warn('job.reject for a job not tracked to this agent, ignoring', {
        agentId,
        jobId,
        reason,
      });
      return;
    }
    this.registry.decrementActiveJobs(agentId);
    this.untrackJob(agentId, jobId);
    await this.requeueOrFail(agentId, jobId, `agent rejected dispatch (${reason})`);
    await this.updateQueueDepthMetric();
  }

  /** Remove a job from all per-agent in-memory tracking. */
  private untrackJob(agentId: string, jobId: string): void {
    // Reject, disconnect triage, and ack expiry all route through here, so
    // clearing the pending ack here covers them with no extra wiring.
    this.resolvePendingAck(jobId);
    this.jobToAgent.delete(jobId);
    this.jobRunIds.delete(jobId);
    this.startedJobs.delete(jobId);
    const jobIds = this.agentJobs.get(agentId);
    if (jobIds) {
      jobIds.delete(jobId);
      if (jobIds.size === 0) this.agentJobs.delete(agentId);
    }
  }

  /**
   * Requeue a dispatched job for re-delivery, or fail it permanently when
   * its attempt budget is exhausted. Returns the outcome so disconnect
   * triage can surface failed job IDs to the caller.
   */
  private async requeueOrFail(
    agentId: string,
    jobId: string,
    context: string,
  ): Promise<'requeued' | 'failed' | 'gone'> {
    const attempts = await this.queue.requeue(jobId);
    if (attempts === null) {
      // Row left 'dispatched' concurrently (completed / cancelled) — done.
      return 'gone';
    }
    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      const reason = `Job failed: re-dispatch attempts exhausted after ${attempts} attempts (${context})`;
      await this.queue.markFailed(jobId, reason);
      const info = await this.queue.getJobById(jobId);
      logger.warn('Job re-dispatch attempts exhausted', { jobId, agentId, attempts, context });
      this.onJobFailedPermanently?.(agentId, jobId, info?.runId ?? '', reason);
      return 'failed';
    }
    logger.info('Job requeued for re-dispatch', { jobId, agentId, attempts, context });
    await this.redispatch(jobId);
    return 'requeued';
  }

  /**
   * Try to deliver a requeued pending job: prefer an idle matching agent
   * (atomic claim via dispatchBoundJob), otherwise consult the scaler so a
   * fresh agent is spawned bound to this job.
   */
  private async redispatch(jobId: string): Promise<void> {
    const job = await this.queue.getFullJobById(jobId);
    if (!job || job.status !== DispatchQueueStatus.Pending) return;

    const available = this.registry.findAvailable(
      job.runsOnLabels,
      job.runsOnPatterns ?? [],
      job.excludeLabels ?? [],
      job.excludePatterns ?? [],
    );
    if (available.length > 0) {
      const dispatched = await this.dispatchBoundJob(available[0].agentId, jobId);
      if (dispatched) return;
    }
    if (this.onNoMatchingAgent) {
      await this.onNoMatchingAgent(
        job.runsOnLabels,
        jobId,
        job.runId,
        job.excludeLabels ?? [],
        job.resources,
      );
    }
  }

  /**
   * Handle agent disconnect. Starts per-job recovery timers instead of
   * immediately failing jobs, giving the agent a grace period to reconnect.
   * If no in-flight jobs, performs a clean disconnect.
   *
   * Returns empty array (no immediately failed jobs -- failures happen
   * asynchronously when recovery timers expire).
   */
  async onAgentDisconnect(agentId: string): Promise<string[]> {
    const scalerManaged = this.registry.get(agentId)?.scalerManaged ?? false;
    const jobIds = this.agentJobs.get(agentId);
    if (!jobIds || jobIds.size === 0) {
      // No in-flight jobs -- clean disconnect
      this.registry.unregister(agentId);
      this.cleanupGraceEntriesForAgent(agentId);
      await this.updateQueueDepthMetric();
      return [];
    }

    const failedJobIds = scalerManaged
      ? await this.triageScalerManagedDisconnect(agentId, [...jobIds])
      : await this.startRecoveryForDisconnect(agentId, jobIds);

    this.cleanupGraceEntriesForAgent(agentId);
    this.registry.unregister(agentId);
    await this.updateQueueDepthMetric();
    return failedJobIds;
  }

  /** Drop grace-window entries owned by an agent. */
  private cleanupGraceEntriesForAgent(agentId: string): void {
    for (const [jobId, entry] of this.completedJobs) {
      if (entry.agentId === agentId) this.completedJobs.delete(jobId);
    }
  }

  /**
   * Scaler-managed agent disconnected: requeue never-started jobs, fail
   * started ones. Returns the permanently failed job IDs.
   */
  private async triageScalerManagedDisconnect(
    agentId: string,
    jobIds: string[],
  ): Promise<string[]> {
    const failedJobIds: string[] = [];
    for (const jobId of jobIds) {
      const job = await this.queue.getJobById(jobId);
      const runId = job?.runId ?? '';
      const started = this.startedJobs.has(jobId);
      this.untrackJob(agentId, jobId);
      if (started) {
        const reason =
          'Job failed: scaler-managed agent disconnected mid-execution (ephemeral agents are destroyed on disconnect)';
        await this.queue.markFailed(jobId, reason);
        logger.warn('Scaler-managed agent lost mid-execution, failing job', {
          agentId,
          jobId,
          runId,
        });
        failedJobIds.push(jobId);
        this.onJobFailedPermanently?.(agentId, jobId, runId, reason);
      } else {
        const outcome = await this.requeueOrFail(
          agentId,
          jobId,
          'scaler-managed agent disconnected before job start',
        );
        if (outcome === 'failed') failedJobIds.push(jobId);
      }
    }
    return failedJobIds;
  }

  /**
   * Static agent disconnected: start per-job recovery timers (the agent
   * may reconnect and reclaim). Always returns [] — failures happen
   * asynchronously when recovery timers expire.
   */
  private async startRecoveryForDisconnect(
    agentId: string,
    jobIds: Set<string>,
  ): Promise<string[]> {
    const disconnectedAt = Date.now();
    const deadline = new Date(disconnectedAt + this.gracePeriodMs);
    for (const jobId of jobIds) {
      // A disconnect supersedes any pending dispatch ack: recovery owns the
      // job now. Static disconnects keep agentJobs (no untrackJob), so clear
      // the pending ack explicitly here.
      this.resolvePendingAck(jobId);
      // Look up runId from DB for the recovery timeout callback
      const job = await this.queue.getJobById(jobId);
      const runId = job?.runId ?? '';

      // Transition job to 'recovering' in DB AND stamp the deadline +
      // agentId so a replacement coord on Raft leader switch can
      // re-create the in-memory timer (`recoverState`) or expire the
      // row in the leader-gated sweep (`sweepExpiredRecoveries`).
      await this.queue.markRecovering(jobId, deadline, agentId);

      const timer = setTimeout(() => {
        this.handleRecoveryExpiry(agentId, jobId).catch((err) => {
          logger.error('Recovery expiry handler failed', {
            jobId,
            agentId,
            error: toErrorMessage(err),
          });
        });
      }, this.gracePeriodMs);

      this.recoveringJobs.set(jobId, { agentId, runId, timer, disconnectedAt });

      // Notify recovery started
      this.onRecoveryStarted?.(agentId, jobId);
    }
    // DON'T delete agentJobs -- keep tracking for reconciliation on reconnect
    return [];
  }

  /**
   * Called when an agent completes a job (success or failure).
   * Decrements active jobs and moves the job to the grace window
   * (instead of immediately removing it) so that late messages
   * (e.g. final log chunks) are still accepted.
   */
  onJobComplete(agentId: string, jobId: string): void {
    // Completion bypasses untrackJob, so clear any pending ack here too.
    this.resolvePendingAck(jobId);
    this.registry.decrementActiveJobs(agentId);
    this.jobToAgent.delete(jobId);
    this.jobRunIds.delete(jobId);
    this.startedJobs.delete(jobId);
    const jobIds = this.agentJobs.get(agentId);
    if (jobIds) {
      jobIds.delete(jobId);
      if (jobIds.size === 0) {
        this.agentJobs.delete(agentId);
      }
    }

    // Mark dispatch_queue entry as completed (prevents stale detector from timing it out)
    this.queue.markCompleted(jobId).catch((err) => {
      logger.warn('Failed to mark dispatch_queue completed', {
        jobId,
        error: toErrorMessage(err),
      });
    });

    // Move to grace window instead of dropping
    this.completedJobs.set(jobId, {
      agentId,
      expiresAt: Date.now() + Dispatcher.GRACE_WINDOW_MS,
    });

    // Enforce cap by evicting oldest entries
    if (this.completedJobs.size > Dispatcher.COMPLETED_JOBS_CAP) {
      const iter = this.completedJobs.keys();
      const oldest = iter.next().value;
      if (oldest !== undefined) {
        this.completedJobs.delete(oldest);
      }
    }
  }

  /**
   * Check if a job is owned by the given agent.
   * Returns true if the job is actively dispatched to the agent,
   * in recovery (agent disconnected but within grace period),
   * or in the grace window (completed within the last 30 seconds).
   */
  isJobOwnedByAgent(agentId: string, jobId: string): boolean {
    // Check active jobs
    const activeJobs = this.agentJobs.get(agentId);
    if (activeJobs?.has(jobId)) {
      return true;
    }

    // Check recovering jobs
    const recovering = this.recoveringJobs.get(jobId);
    if (recovering && recovering.agentId === agentId) {
      return true;
    }

    // Check grace window
    const completed = this.completedJobs.get(jobId);
    if (completed && completed.agentId === agentId && completed.expiresAt > Date.now()) {
      return true;
    }

    return false;
  }

  /**
   * Resolve which agent a dispatched job was sent to.
   * Used by the cancel-run API. Returns null if the job is not tracked (e.g. already completed).
   */
  getAgentIdForJob(jobId: string): string | null {
    return this.jobToAgent.get(jobId) ?? null;
  }

  /**
   * Start periodic cleanup of expired grace window entries.
   * Should be called during server startup.
   */
  startGraceCleanup(): void {
    if (this.graceCleanupTimer) return;

    this.graceCleanupTimer = setInterval(() => {
      this.cleanupExpiredGraceEntries();
    }, Dispatcher.GRACE_CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop periodic grace cleanup.
   * Should be called during server shutdown.
   */
  stopGraceCleanup(): void {
    if (this.graceCleanupTimer) {
      clearInterval(this.graceCleanupTimer);
      this.graceCleanupTimer = null;
    }
  }

  // ── Recovery ─────────────────────────────────────────────────────

  /**
   * Claim a recovering job back for a reconnected agent.
   * Cancels the recovery timer and returns true if the job was in recovery
   * for this agent. Returns false if the job is not recovering or belongs
   * to a different agent.
   */
  claimRecovery(jobId: string, agentId: string): boolean {
    const entry = this.recoveringJobs.get(jobId);
    if (!entry || entry.agentId !== agentId) return false;

    clearTimeout(entry.timer);
    this.recoveringJobs.delete(jobId);
    return true;
  }

  /**
   * Full reconciliation of a recovering job for a reconnected agent.
   * Claims the recovery timer, transitions DB status back to dispatched,
   * and restores in-memory tracking. Returns true if reconciled.
   */
  async reconcileRecovery(jobId: string, agentId: string): Promise<boolean> {
    // Capture the runId from the recovery entry before claimRecovery deletes it.
    const runId = this.recoveringJobs.get(jobId)?.runId;
    const claimed = this.claimRecovery(jobId, agentId);
    if (!claimed) return false;
    await this.queue.markDispatchedIfRecovering(jobId);
    this.restoreJobForAgent(agentId, jobId, runId);
    return true;
  }

  /**
   * Get recovery info for a job (for structured logging).
   */
  getRecoveryInfo(jobId: string): { disconnectedAt: number; agentId: string } | null {
    const entry = this.recoveringJobs.get(jobId);
    return entry ? { disconnectedAt: entry.disconnectedAt, agentId: entry.agentId } : null;
  }

  /**
   * Get all recovering job IDs for a specific agent.
   * Used during reconnection reconciliation.
   */
  getRecoveringJobsForAgent(agentId: string): string[] {
    const jobIds: string[] = [];
    for (const [jobId, entry] of this.recoveringJobs) {
      if (entry.agentId === agentId) jobIds.push(jobId);
    }
    return jobIds;
  }

  /**
   * Restore a reconciled job into the dispatcher's in-memory tracking.
   * Called when an agent reconnects and claims a recovering job. A
   * reconnecting agent reporting the job in-flight means it had started,
   * so mark it started for disconnect triage.
   */
  restoreJobForAgent(agentId: string, jobId: string, runId?: string): void {
    // Recovery preserves the existing jobRunIds entry (static disconnect keeps
    // tracking), so fall back to it when the caller has no runId to hand.
    this.trackJobForAgent(agentId, jobId, runId ?? this.jobRunIds.get(jobId) ?? '');
    this.startedJobs.add(jobId);
  }

  /**
   * Start a recovery timer for a job found in 'dispatched' state on startup.
   * Called by server.ts/standalone.ts to create recovery timers for jobs
   * from a previous orchestrator instance.
   */
  async startRecoveryTimer(jobId: string, agentId: string, runId: string): Promise<void> {
    const disconnectedAt = Date.now();
    const deadline = new Date(disconnectedAt + this.gracePeriodMs);
    await this.queue.markRecovering(jobId, deadline, agentId);
    const timer = setTimeout(() => {
      this.handleRecoveryExpiry(agentId, jobId).catch((err) => {
        logger.error('Recovery expiry handler failed', {
          jobId,
          agentId,
          error: toErrorMessage(err),
        });
      });
    }, this.gracePeriodMs);
    this.recoveringJobs.set(jobId, { agentId, runId, timer, disconnectedAt });
    this.onRecoveryStarted?.(agentId, jobId);
  }

  /**
   * Rebuild the in-memory `recoveringJobs` Map from persisted
   * `dispatch_queue` rows after a coord boot / Raft leader switch.
   *
   * For each `status='recovering'` row:
   *   - if `recovery_deadline` is in the future, recreate a setTimeout
   *     with the remaining window so the local sweep still fires.
   *   - if the deadline is already in the past, leave the row alone —
   *     the leader-gated `sweepExpiredRecoveries()` will pick it up on
   *     its next tick (which avoids two coords racing to mark the same
   *     job failed during recovery).
   *   - rows with NULL deadline (pre-migration recovering jobs) are
   *     fast-failed by the sweep on its first run.
   */
  async recoverState(): Promise<void> {
    const rows = await this.queue.getRecoveringJobs();
    const now = Date.now();
    let hydrated = 0;
    for (const row of rows) {
      if (!row.agentId) continue; // Pre-migration row; sweep will handle it.
      if (!row.deadline) continue; // Same.
      const msRemaining = row.deadline.getTime() - now;
      if (msRemaining <= 0) continue; // Already expired; sweep will finalize.
      // Skip if we already have a timer (e.g. recoverState called twice).
      if (this.recoveringJobs.has(row.id)) continue;
      const timer = setTimeout(() => {
        const agentId = row.agentId as string;
        this.handleRecoveryExpiry(agentId, row.id).catch((err) => {
          logger.error('Recovery expiry handler failed', {
            jobId: row.id,
            agentId,
            error: toErrorMessage(err),
          });
        });
      }, msRemaining);
      this.recoveringJobs.set(row.id, {
        agentId: row.agentId,
        runId: row.runId,
        timer,
        disconnectedAt: row.deadline.getTime() - this.gracePeriodMs,
      });
      hydrated++;
    }
    if (hydrated > 0 || rows.length > 0) {
      logger.info('dispatcher: rehydrated recovery timers from DB', {
        rehydrated: hydrated,
        totalRecovering: rows.length,
      });
    }

    // Re-arm dispatch-ack timers persisted by a previous coord. Rows whose
    // deadline already passed are left to the leader-gated ack sweep.
    const ackRows = await this.queue.getDispatchedAwaitingAck();
    let ackRearmed = 0;
    for (const row of ackRows) {
      if (this.pendingAcks.has(row.id)) continue;
      const msRemaining = row.deadline.getTime() - now;
      if (msRemaining <= 0) continue;
      const agentId = row.agentId ?? '';
      const timer = setTimeout(() => {
        this.handleAckExpiry(agentId, row.id, row.runId).catch((err) => {
          logger.error('Ack expiry handler failed', {
            jobId: row.id,
            agentId,
            error: toErrorMessage(err),
          });
        });
      }, msRemaining);
      this.pendingAcks.set(row.id, { agentId, runId: row.runId, timer });
      ackRearmed++;
    }
    if (ackRearmed > 0) {
      logger.info('dispatcher: rehydrated ack-deadline timers from DB', { rehydrated: ackRearmed });
    }
  }

  /**
   * Leader-gated sweep: requeue every `dispatched` row whose ack deadline
   * passed while no coord was watching (owning coord crashed before its
   * in-memory timer fired). Requeue is atomic (WHERE status='dispatched'),
   * so racing coords cannot double-requeue.
   */
  async sweepExpiredAckDeadlines(): Promise<number> {
    const expired = await this.queue.listExpiredAckDeadlines(new Date());
    for (const row of expired) {
      const entry = this.pendingAcks.get(row.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pendingAcks.delete(row.id);
      }
      await this.queue.clearAckDeadline(row.id);
      logger.warn('Ack sweep: dispatched job past its ack deadline, requeueing', {
        jobId: row.id,
        runId: row.runId,
        agentId: row.agentId ?? '',
      });
      if (row.agentId && this.registry.get(row.agentId)) {
        this.registry.decrementActiveJobs(row.agentId);
        this.untrackJob(row.agentId, row.id);
        // Close the WS first (reads the agent entry), then remove from routing
        // before requeueing so the redispatch cannot re-select it (same order
        // as handleAckExpiry).
        this.onAckTimeout?.(row.agentId, row.id, row.runId);
        this.registry.unregister(row.agentId);
      }
      await this.requeueOrFail(row.agentId ?? '', row.id, 'dispatch ack deadline sweep');
    }
    if (expired.length > 0) {
      logger.info('dispatcher: leader sweep requeued un-acked dispatches', {
        expired: expired.length,
      });
    }
    return expired.length;
  }

  /**
   * Leader-gated sweep: mark every `recovering` row whose
   * `recovery_deadline < now` as `failed` and fire the per-job
   * `onJobFailedPermanently` hook. Intended to run on the Raft leader at a
   * fixed interval so jobs whose owning coord crashed mid-recovery
   * still reach a terminal state.
   *
   * Safe to call on non-leaders (idempotent due to the WHERE clause)
   * but skipping the call on followers avoids redundant DB updates.
   */
  async sweepExpiredRecoveries(): Promise<number> {
    const expired = await this.queue.sweepExpiredRecoveries(new Date());
    for (const row of expired) {
      // Cancel any local timer (the case where the same coord owned
      // the row AND the sweep). Otherwise the timer would fire after
      // the row is already terminal — benign, but tidy.
      const entry = this.recoveringJobs.get(row.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.recoveringJobs.delete(row.id);
      }
      const reason =
        'Job failed: agent disconnected and did not reconnect within the recovery window';
      logger.warn('Job recovery timed out', {
        agentId: row.agentId ?? '',
        jobId: row.id,
        runId: row.runId,
      });
      this.onJobFailedPermanently?.(row.agentId ?? '', row.id, row.runId, reason);
    }
    if (expired.length > 0) {
      logger.info('dispatcher: leader sweep expired recovering jobs', {
        expired: expired.length,
      });
    }
    return expired.length;
  }

  /**
   * Stop all recovery timers. Called during graceful shutdown.
   */
  stopRecoveryTimers(): void {
    for (const [, entry] of this.recoveringJobs) {
      clearTimeout(entry.timer);
    }
    this.recoveringJobs.clear();
    // Pending dispatch-ack timers are armed by the same coord; tear them down
    // on shutdown so the process can exit cleanly.
    for (const [, entry] of this.pendingAcks) {
      clearTimeout(entry.timer);
    }
    this.pendingAcks.clear();
    this.earlyAcks.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Handle recovery timer expiry for a single job.
   * Extracted so that both onAgentDisconnect and startRecoveryTimer share the same logic,
   * and the caller can `.catch()` to prevent unhandled rejections in setTimeout.
   */
  private async handleRecoveryExpiry(agentId: string, jobId: string): Promise<void> {
    const entry = this.recoveringJobs.get(jobId);
    const entryRunId = entry?.runId ?? '';
    this.recoveringJobs.delete(jobId);
    // Also remove from agentJobs/jobToAgent tracking
    this.jobToAgent.delete(jobId);
    this.jobRunIds.delete(jobId);
    this.startedJobs.delete(jobId);
    const agentJobIds = this.agentJobs.get(agentId);
    if (agentJobIds) {
      agentJobIds.delete(jobId);
      if (agentJobIds.size === 0) this.agentJobs.delete(agentId);
    }
    // Grace period expired -- permanently fail (optimistic: only if still recovering)
    const reason =
      'Job failed: agent disconnected and did not reconnect within the recovery window';
    logger.warn('Job recovery timed out', { agentId, jobId, runId: entryRunId });
    await this.queue.markFailedIfRecovering(jobId, reason);
    // Notify scaler (pass runId so caller can update execution tracker)
    this.onJobFailedPermanently?.(agentId, jobId, entryRunId, reason);
  }

  /** Remove expired entries from the completedJobs grace window map. */
  private cleanupExpiredGraceEntries(): void {
    const now = Date.now();
    for (const [jobId, entry] of this.completedJobs) {
      if (entry.expiresAt <= now) {
        this.completedJobs.delete(jobId);
      }
    }
  }

  private trackJobForAgent(agentId: string, jobId: string, runId: string): void {
    this.jobToAgent.set(jobId, agentId);
    this.jobRunIds.set(jobId, runId);
    let jobIds = this.agentJobs.get(agentId);
    if (!jobIds) {
      jobIds = new Set();
      this.agentJobs.set(agentId, jobIds);
    }
    jobIds.add(jobId);
  }

  /**
   * Verify `agentId` currently owns `jobId`; if so, return the job's runId from
   * the dispatcher's own tracking. Used by the provenance token relay so the
   * orchestrator binds a minted token to a job the agent actually owns — the
   * agent never asserts a runId. Returns `undefined` when the agent does not
   * own the job (or the runId is no longer tracked).
   */
  resolveOwnedJob(agentId: string, jobId: string): { runId: string } | undefined {
    if (!this.agentJobs.get(agentId)?.has(jobId)) return undefined;
    const runId = this.jobRunIds.get(jobId);
    return runId ? { runId } : undefined;
  }

  /**
   * Cancel a queued job (mark as failed in the dispatch queue).
   * Used by the coordinator to clean up local fallback entries when a peer
   * accepts the rerouted job.
   */
  async cancelQueuedJob(jobId: string, reason: string): Promise<void> {
    await this.queue.markFailed(jobId, reason);
    await this.updateQueueDepthMetric();
  }

  private async updateQueueDepthMetric(): Promise<void> {
    const depth = await this.queue.getDepth();
    this.metrics.setQueueDepth(depth);
  }
}
