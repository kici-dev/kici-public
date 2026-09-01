import { requiredRuntimeLabelsFor } from '../pipeline/dispatch-matched-workflow.js';
import type { AgentRegistry } from './registry.js';
import {
  DispatchQueueStatus,
  MAX_DISPATCH_ATTEMPTS,
  resourcesFromJobConfig,
  type JobQueue,
  type QueuedJob,
  type QueuedJobInput,
} from '../queue/job-queue.js';
import type { ScaleResult, ScalerRedispatchTrigger } from '../scaler/types.js';
import type { ResolvedContainerSpawn } from '../scaler/types.js';
import type { ResourceRequest, RunsOnPick } from '@kici-dev/engine';
import type { AgentEntry } from './registry.js';
import { requestContext, createLogger, toErrorMessage } from '@kici-dev/shared';

const logger = createLogger({ prefix: 'dispatcher' });

/**
 * Why a freed agent's queue drain claimed nothing.
 *
 * Named rather than inlined because the value travels: it is the `reason`
 * field of the drain-declined log line and the assertion subject of the tests
 * that pin each exit. The five members are the five ways
 * `Dispatcher.drainForAgent` can return without a dispatch.
 */
export enum AgentDrainDecline {
  /** The agent id is not in the in-memory registry (already disconnected). */
  NotRegistered = 'agent-not-registered',
  /** This coordinator is draining and must not claim new work. */
  CoordinatorDraining = 'coordinator-draining',
  /** The agent is already at `maxConcurrency`. */
  NoCapacity = 'no-capacity',
  /** The host is flagged reboot-pending, so anything dispatched would be lost. */
  RebootPending = 'reboot-pending',
  /** Nothing in the queue matched this agent's labels or pin. */
  NoMatchingJob = 'no-matching-job',
}

/**
 * Default per-pass cap on how many pending jobs a capacity-freed re-drive
 * re-offers to the scaler. Bounds the burst so a single free event cannot storm
 * the scaler; the per-backend spawn semaphore bounds actual provisioning, and a
 * job that gets `at-capacity` again simply stays pending for the next tick.
 */
export const DEFAULT_REDRIVE_BATCH = 10;

/**
 * Pick the single agent to run a label-routed job from the matching candidates.
 *
 * `pick` comes from the job's `runsOn.pick` (carried in `jobConfig.runsOnPick`):
 * - `deterministic` (the default, and any unset value): sort candidates by
 *   `agentId` and take the lowest, so a run-once-on-one-host job (a migration, a
 *   dump) lands on the same host across re-runs.
 * - `any`: take the first available candidate (load spread / current behavior).
 *
 * `available` is never empty (callers guard `available.length > 0`).
 */
function selectAgent(available: AgentEntry[], jobConfig: Record<string, unknown>): AgentEntry {
  const pick = jobConfig.runsOnPick as RunsOnPick | undefined;
  if (pick === 'any') return available[0];
  return [...available].sort((a, b) => a.agentId.localeCompare(b.agentId))[0];
}

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
  /** Record `count` pending jobs re-driven through the scaler by `trigger`. */
  incScalerRedispatch(trigger: ScalerRedispatchTrigger, count: number): void;
}

/**
 * Narrow slice of `HostRosterStore` the dispatcher needs for the host-restart
 * flow. Kept as an interface so the dispatcher doesn't import the full store
 * (which pulls in engine label matchers) and to make the reboot logic testable
 * with a tiny in-memory stub.
 */
export interface HostRosterRebootStore {
  /** True when the host's reboot-pending deadline is still in the future. */
  isRebootPending(agentId: string, nowMs: number): Promise<boolean>;
  /** Clear the reboot-pending flag (down-then-up release on reconnect). */
  clearRebootPending(agentId: string): Promise<void>;
}

/**
 * Result of a dispatch attempt.
 *
 * `duplicate` = the dispatch_queue row for a preassigned (rerouted) jobId
 * already existed, so nothing was dispatched here (the claimed agent slot is
 * released and onDispatch is NOT called). The reroute caller should treat the
 * job as already handled. Only reachable on a reroute re-dispatch — first-
 * dispatch paths use a fresh UUID that can never collide.
 */
type DispatchResult =
  | { status: 'dispatched'; agentId: string; jobId: string }
  | { status: 'queued'; jobId: string }
  | { status: 'queued-no-backend'; jobId: string }
  | { status: 'duplicate'; jobId: string }
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

/**
 * The job's container spawn, assembled from what dispatch already resolved.
 *
 * Both pieces are on `jobConfig` by the time a job is queued: `container` from
 * the lock, and `containerRegistryAuth` resolved orchestrator-side. Nothing is
 * re-resolved here — a second resolution would be a second chance to disagree.
 *
 * A job that BUILDS its image (`container.dockerfile`) carries no `image`, so
 * this returns `undefined` and no per-job-image spawn happens. That is load
 * bearing, not incidental: the image does not exist until an agent has cloned
 * and built it, so the job has to be run by an ordinary agent that nests the
 * container. `dispatcher.test.ts` pins it.
 *
 * Exported for that test — the behaviour is a routing decision, and a routing
 * decision that only holds by accident is one refactor away from breaking.
 */
/**
 * Labels a job needs from a REGISTERED agent, beyond what its `runsOn` names.
 *
 * A `container.dockerfile` job additionally needs a host that can build an
 * image, which the agent self-reports as `kici:runtime:container-build`. Applied
 * here and not to the scaler consult: a backend is chosen by exact label-set
 * containment, so requiring a label no pool declares would strand the job
 * `queued-no-backend` instead of spawning anything.
 */
function matchLabelsFor(job: {
  runsOnLabels: string[];
  jobConfig?: Record<string, unknown> | undefined;
}): string[] {
  const extra = requiredRuntimeLabelsFor(job.jobConfig?.container);
  return extra.length === 0 ? job.runsOnLabels : [...job.runsOnLabels, ...extra];
}

export function containerSpawnFor(jobConfig: Record<string, unknown> | undefined) {
  const container = jobConfig?.container;
  const image =
    typeof container === 'string'
      ? container
      : typeof (container as { image?: unknown } | undefined)?.image === 'string'
        ? (container as { image: string }).image
        : undefined;
  if (!image) return undefined;

  const authconfig = jobConfig?.containerRegistryAuth as
    { username: string; password: string; serveraddress: string } | undefined;
  return { image, ...(authconfig ? { authconfig } : {}) };
}

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
        orgId?: string,
        containerSpawn?: ResolvedContainerSpawn,
      ) => Promise<ScaleResult>)
    | undefined;

  /** See the constructor dep of the same name. */
  private readonly canPrespawnedAgentServe?:
    | ((
        agentId: string,
        job: { resources?: ResourceRequest; hasOwnContainerImage: boolean },
      ) => boolean)
    | undefined;

  /** See the constructor dep of the same name. */
  private readonly isPrespawnedAgent?: ((agentId: string) => boolean) | undefined;

  /**
   * Single-flight guard for `retryPendingScaleRequests`. The capacity-freed
   * hook and the leader-gated sweep can both fire concurrently; this prevents
   * two re-drives from double-offering the same pending jobs to the scaler in
   * the same tick.
   */
  private redriveInFlight = false;

  /**
   * Single-flight guard for `redrivePendingToConnectedAgents`. The per-coord
   * safety-net tick must not overlap itself, so a slow re-drive can't be
   * re-entered by the next interval fire and double-scan the same pending rows.
   */
  private pendingRedriveInFlight = false;

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
    ((agentId: string, jobId: string, runId: string, reason: string) => void) | undefined;

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
    ((agentId: string, jobId: string, runId: string) => void) | undefined;

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

  /** Host roster store for the reboot-pending gate; undefined ⇒ flow inert. */
  private readonly rosterStore?: HostRosterRebootStore;

  /** Coordinator drain predicate; when true, new jobs queue Pending instead of
   *  dispatching. Defaults to never-draining. */
  private readonly isDraining: () => boolean;

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
      orgId?: string,
      /**
       * The job's own container image plus registry credentials, already
       * resolved at dispatch. Present means the backend spawns THAT image with
       * the KiCI runtime injected instead of the pool's fixed agent image.
       */
      containerSpawn?: ResolvedContainerSpawn,
    ) => Promise<ScaleResult>;
    /**
     * Optional scaler predicate: may this pre-spawned (warm) agent serve this
     * job? A warm agent is generic — started before the job existed, at the
     * pool's shape and running the pool's image, both of which are fixed when
     * it starts. When the predicate returns false the agent is skipped and the
     * job falls through to `onNoMatchingAgent`, which spawns one that fits.
     * Absent (no scaler) means every agent is eligible.
     */
    canPrespawnedAgentServe?: (
      agentId: string,
      job: { resources?: ResourceRequest; hasOwnContainerImage: boolean },
    ) => boolean;
    /**
     * Whether this scaler pre-spawned the agent, i.e. whether
     * `canPrespawnedAgentServe` can ever answer false for it. The queue drain
     * (agent asks for work, rather than job looks for an agent) uses it to
     * decide whether the suitability predicate is worth carrying into the
     * claim: for every ordinary agent it is not, and the drain keeps its
     * single-statement fast path.
     */
    isPrespawnedAgent?: (agentId: string) => boolean;
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
    /**
     * Host roster store, used for the workflow-level host-restart flow: gate the
     * pinned-drain off for a reboot-pending agent, and treat a reboot-pending
     * agent's disconnect as the expected reboot (complete its in-flight job
     * success rather than starting the recovery-fail timer). Omitted ⇒ the
     * reboot-pending behavior is inert (every host reads not-pending).
     */
    rosterStore?: HostRosterRebootStore;
    /** Coordinator drain predicate. When true, dispatch() enqueues new jobs as
     *  Pending and onAgentAvailable() claims nothing — jobs already on agents
     *  finish. Defaults to never-draining. */
    isDraining?: () => boolean;
  }) {
    this.registry = deps.registry;
    this.queue = deps.queue;
    this.metrics = deps.metrics;
    this.onDispatch = deps.onDispatch;
    this.onNoMatchingAgent = deps.onNoMatchingAgent;
    this.canPrespawnedAgentServe = deps.canPrespawnedAgentServe;
    this.isPrespawnedAgent = deps.isPrespawnedAgent;
    this.isDraining = deps.isDraining ?? (() => false);
    this.maxReconnectDelayMs = deps.maxReconnectDelayMs ?? 60_000;
    this.onJobFailedPermanently = deps.onJobFailedPermanently;
    this.onRecoveryStarted = deps.onRecoveryStarted;
    this.getAckTimeoutMs = deps.getAckTimeoutMs ?? (async () => Dispatcher.DEFAULT_ACK_TIMEOUT_MS);
    this.onAckTimeout = deps.onAckTimeout;
    this.rosterStore = deps.rosterStore;
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

    // Coordinator draining: never send a new job to an agent or spawn capacity.
    // Enqueue as Pending so the fresh coordinator drains it after the upgrade
    // restart (Model A / job-level drain). Every new job — new-run first job or
    // in-flight-run downstream ready job — becomes Pending; only jobs already
    // executing on agents finish.
    if (this.isDraining()) {
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

    const availableRaw = this.registry.findAvailable(
      matchLabelsFor(job),
      job.runsOnPatterns ?? [],
      job.excludeLabels ?? [],
      job.excludePatterns ?? [],
    );

    // Reboot-pending gate (label-routed path): a `restartHost()` workflow pins
    // the post-restart job to the same host via a `runsOn: 'kici:host:<id>'`
    // label. That job reaches THIS path (not dispatchPinned) when its `needs`
    // are satisfied, so exclude any matched agent whose reboot-pending flag is
    // set — the job then queues (held) until the host reboots back and the
    // reconnect clears the flag, at which point onAgentAvailable drains it.
    //
    // Suitability gate: a warm agent whose fixed-at-spawn shape or image does
    // not fit this job is dropped too, so the job falls through to the scale
    // path below and gets an agent that does fit.
    const available = this.filterUnsuitablePrespawned(
      await this.filterRebootPending(availableRaw),
      job,
    );

    if (available.length > 0) {
      // Select per the job's runsOn.pick policy (deterministic-by-agentId by
      // default; `any` keeps first-available).
      const agent = selectAgent(available, job.jobConfig);

      // Claim the slot before the async insert (same race as onAgentAvailable).
      this.registry.incrementActiveJobs(agent.agentId);
      let insertResult: { id: string; inserted: boolean };
      try {
        // Persist the job in dispatch_queue with status='dispatched' for:
        // - Audit trail of all dispatched jobs
        // - Ability to mark as failed on agent disconnect
        // - State recovery after orchestrator restart
        // Idempotent on the primary key: a rerouted jobId already written by a
        // sibling coordinator (or an earlier reroute) makes this a no-op instead
        // of a pkey error.
        insertResult = await this.queue.insertDispatched(job, agent.agentId);
      } catch (err) {
        this.registry.decrementActiveJobs(agent.agentId);
        throw err;
      }
      if (!insertResult.inserted) {
        // The row already exists — the job is tracked elsewhere. Release the slot
        // we just claimed and report the benign duplicate; do NOT double-dispatch
        // it to this agent. Only reachable on a preassigned (rerouted) jobId.
        this.registry.decrementActiveJobs(agent.agentId);
        logger.info('Reroute re-dispatch no-op — job already present in dispatch_queue', {
          runId: job.runId,
          jobId: insertResult.id,
          jobName: job.jobName,
        });
        return { status: 'duplicate', jobId: insertResult.id };
      }
      const jobId = insertResult.id;

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
      const containerSpawn = containerSpawnFor(job.jobConfig);
      const scaleResult = await this.onNoMatchingAgent(
        job.runsOnLabels,
        jobId,
        job.runId,
        job.excludeLabels ?? [],
        // Same reading as the fit gate: the typed mirror is optional and this
        // path takes an input built by a caller, not a row the queue
        // materialized. Resources apply only at spawn time, so a shape read as
        // absent here starts the job's own agent at the label-set default and
        // the job runs at a size it did not ask for.
        job.resources ?? resourcesFromJobConfig(job.jobConfig),
        typeof job.jobConfig?.cacheOrgId === 'string' ? job.jobConfig.cacheOrgId : undefined,
        containerSpawn,
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
   * Re-drive the scaler for jobs still pending after an `at-capacity` verdict.
   *
   * Called by the capacity-freed hook (`ScalerManager.onCapacityFreed`) and the
   * leader-gated `PendingScaleSweeper`. Lists the oldest pending jobs (FIFO
   * fairness — the longest-waiting burst victim gets the freed slot first) and
   * re-runs the SAME `onNoMatchingAgent` → `requestScale` path used at dispatch
   * time, so the re-drive inherits the per-backend spawn semaphore and cap
   * accounting. A job that returns `at-capacity` again just stays pending for
   * the next free/sweep tick — no retry state, no backoff bookkeeping.
   *
   * Single-flight: a second call while one is in flight returns 0, so an
   * overlapping hook+sweep cannot double-offer the same jobs. Bounded by
   * `maxJobs` so one free event cannot storm the scaler.
   *
   * @returns the number of jobs that entered `spawning`.
   */
  async retryPendingScaleRequests(
    maxJobs: number = DEFAULT_REDRIVE_BATCH,
    trigger: ScalerRedispatchTrigger = 'hook',
  ): Promise<number> {
    if (!this.onNoMatchingAgent || this.redriveInFlight) return 0;
    this.redriveInFlight = true;
    try {
      const pending = await this.queue.listPending(maxJobs);
      let redriven = 0;
      for (const job of pending) {
        const containerSpawn = containerSpawnFor(job.jobConfig);
        const result = await this.onNoMatchingAgent(
          job.runsOnLabels,
          job.id,
          job.runId,
          job.excludeLabels ?? [],
          job.resources,
          typeof job.jobConfig?.cacheOrgId === 'string' ? job.jobConfig.cacheOrgId : undefined,
          containerSpawn,
        );
        if (result.action === 'spawning') redriven++;
      }
      if (redriven > 0) {
        this.metrics.incScalerRedispatch(trigger, redriven);
        logger.info('Re-drove pending jobs after capacity freed', {
          trigger,
          redriven,
          scanned: pending.length,
        });
      }
      return redriven;
    } catch (err) {
      logger.warn('Pending-scale re-drive failed', { trigger, error: toErrorMessage(err) });
      return 0;
    } finally {
      this.redriveInFlight = false;
    }
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
    // Reboot-pending gate: a host whose `restart` job just completed is still
    // connected but about to reboot. Never dispatch its pinned post-restart job
    // into the about-to-die box — queue it with the pin so the down-then-up
    // reconnect releases it. (This is the direct-dispatch counterpart of the
    // same gate in onAgentAvailable; the post-restart job reaches HERE when its
    // `needs` are satisfied by the restart job completing.)
    const rebootPending = (await this.rosterStore?.isRebootPending(agentId, Date.now())) ?? false;
    const dispatchable =
      // Coordinator draining: never send even a pinned job to an agent — fall
      // through to the queue-with-pin path so the pin is preserved and the
      // fresh coordinator delivers it after the upgrade restart.
      !this.isDraining() &&
      !rebootPending &&
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
      let insertResult: { id: string; inserted: boolean };
      try {
        insertResult = await this.queue.insertDispatched(job, agentId);
      } catch (err) {
        this.registry.decrementActiveJobs(agentId);
        throw err;
      }
      if (!insertResult.inserted) {
        this.registry.decrementActiveJobs(agentId);
        logger.info('Reroute re-dispatch no-op — pinned job already present in dispatch_queue', {
          runId: job.runId,
          jobId: insertResult.id,
          jobName: job.jobName,
          pinnedAgentId: agentId,
        });
        return { status: 'duplicate', jobId: insertResult.id };
      }
      const jobId = insertResult.id;
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

    // Coordinator draining: do not claim a scaler-bound job onto a freshly
    // registered agent. The job stays Pending and the fresh coordinator
    // re-dispatches it after the upgrade restart.
    if (this.isDraining()) return false;

    // Claim the slot before the async dequeue (same race as onAgentAvailable).
    this.registry.incrementActiveJobs(agentId);
    let job: QueuedJob | null = null;
    try {
      job = await this.queue.dequeueById(
        jobId,
        [...agent.labels],
        [...agent.mandatoryLabels],
        agentId,
      );
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
  /**
   * Drop agents whose reboot-pending flag is set from a candidate list. Used by
   * the label-routed dispatch path so a post-restart job is never sent to a host
   * that is about to reboot. No-op when no roster store is wired.
   */
  private async filterRebootPending<T extends { agentId: string }>(agents: T[]): Promise<T[]> {
    if (!this.rosterStore || agents.length === 0) return agents;
    const now = Date.now();
    const out: T[] = [];
    for (const agent of agents) {
      if (!(await this.rosterStore.isRebootPending(agent.agentId, now))) out.push(agent);
    }
    return out;
  }

  /**
   * Drop pre-spawned (warm) agents that cannot serve this job. Sibling of
   * {@link filterRebootPending}: both remove candidates `findAvailable` matched
   * on labels but that are unusable for a reason labels cannot express.
   *
   * A warm agent's cpu, memory and container image are all set when it starts
   * and cannot change afterwards, so a job asking for something else has to get
   * an agent of its own. Dropping the candidate here is what sends it down the
   * ordinary `onNoMatchingAgent` scale path. No-op when no scaler is wired.
   */
  private filterUnsuitablePrespawned<T extends { agentId: string }>(
    agents: T[],
    job: { resources?: ResourceRequest; jobConfig?: Record<string, unknown> | undefined },
  ): T[] {
    const predicate = this.canPrespawnedAgentServe;
    if (!predicate || agents.length === 0) return agents;
    const fit = this.prespawnedFitFor(job);
    return agents.filter((a) => predicate(a.agentId, fit));
  }

  /**
   * The fit question for one job: the shape it declares, and whether it brings
   * its own container image.
   *
   * The shape comes from `jobConfig.resources` when the typed `resources`
   * mirror is absent, because the mirror is optional and several dispatch paths
   * never fill it — a job reaching {@link dispatch} straight off the webhook
   * pipeline or off a worker's reroute handler carries its declaration in
   * `jobConfig` alone. Reading only the mirror there reports a job that
   * declares nothing, which admits it onto a pre-spawned agent of some other
   * size — the exact mismatch this gate exists to refuse.
   */
  private prespawnedFitFor(job: {
    resources?: ResourceRequest;
    jobConfig?: Record<string, unknown> | undefined;
  }): { resources?: ResourceRequest; hasOwnContainerImage: boolean } {
    const declared = job.resources ?? resourcesFromJobConfig(job.jobConfig);
    return {
      ...(declared ? { resources: declared } : {}),
      hasOwnContainerImage: containerSpawnFor(job.jobConfig) !== undefined,
    };
  }

  /**
   * The queue-drain half of {@link filterUnsuitablePrespawned}: a per-job
   * predicate for one agent, or undefined when this agent needs no check.
   *
   * Undefined is the common answer — an ordinary agent is not pre-spawned, so
   * the predicate could only ever say yes, and returning one would cost the
   * drain its single-statement fast path for nothing.
   */
  private prespawnedFitFilterFor(agentId: string): ((job: QueuedJob) => boolean) | undefined {
    const predicate = this.canPrespawnedAgentServe;
    if (!predicate || !this.isPrespawnedAgent?.(agentId)) return undefined;
    return (job) => predicate(agentId, this.prespawnedFitFor(job));
  }

  /**
   * Release a reboot-pending host on its real reconnect (down-then-up). Clears
   * the persisted flag so the very next `onAgentAvailable` drain dispatches the
   * held post-restart job. Call this ONLY from the (re-)register path — a fresh
   * connection after the box rebooted — never from a still-connected drain
   * trigger (job completion / agent.status), which must keep the gate closed.
   */
  async releaseRebootPending(agentId: string): Promise<void> {
    if (!this.rosterStore) return;
    if (await this.rosterStore.isRebootPending(agentId, Date.now())) {
      await this.rosterStore.clearRebootPending(agentId);
      logger.info('Reboot-pending host reconnected; cleared flag (down-then-up release)', {
        agentId,
      });
    }
  }

  async onAgentAvailable(agentId: string): Promise<void> {
    const declined = await this.drainForAgent(agentId);
    const depth = await this.queue.getDepth();
    this.metrics.setQueueDepth(depth);

    // A drain that declines while the queue is EMPTY is the steady state and
    // says nothing; one that declines while work is waiting is the shape of a
    // job stranded on a queue an agent could have taken. Those two used to be
    // byte-identical in the log — five distinct exits, none of them logged —
    // which is why a pinned, label-matching queued job sitting undrained for a
    // full minute after a host reconnect could not be told apart from an idle
    // orchestrator. Gated on a non-empty queue so an idle fleet stays quiet,
    // and at `info` because a deployment running at `debug` is not the one
    // that needs the answer.
    if (declined !== null && depth > 0) {
      logger.info('Agent drain declined while the queue is non-empty', {
        agentId,
        reason: declined,
        queueDepth: depth,
      });
    }
  }

  /**
   * Claim at most one queued job for a freed agent.
   *
   * Returns the reason nothing was dispatched, or null when a job was.
   */
  private async drainForAgent(agentId: string): Promise<AgentDrainDecline | null> {
    const agent = this.registry.get(agentId);
    if (!agent) return AgentDrainDecline.NotRegistered;

    // Coordinator draining: do not claim new queued work onto a freed agent.
    if (this.isDraining()) return AgentDrainDecline.CoordinatorDraining;

    const agentLabels = [...agent.labels];
    const agentMandatoryLabels = [...agent.mandatoryLabels];

    // Reboot-pending gate: while this host's reboot-pending flag is set it is
    // still connected but about to reboot. Do NOT dispatch its pinned
    // post-restart job into the about-to-die box — leave it held. The flag is
    // cleared on the reconnect (down-then-up) before that reconnect's
    // onAgentAvailable runs, so the release happens on the real reboot cycle,
    // not on the brief still-connected window after the restart job completes.
    const rebootPending = (await this.rosterStore?.isRebootPending(agentId, Date.now())) ?? false;

    if (agent.activeJobs >= agent.maxConcurrency) return AgentDrainDecline.NoCapacity;
    if (rebootPending) return AgentDrainDecline.RebootPending;

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
      //
      // The generic drain is the mirror of `dispatch()`: this agent asks for
      // any label-matching job rather than a job looking for an agent, so the
      // same suitability gate has to apply — an `agent.status` tick would
      // otherwise hand a pre-spawned agent the very job `dispatch()` just
      // refused it. It is carried into the claim rather than checked after,
      // because a claimed-then-released row is stranded Dispatched for a window
      // and burns one of the job's bounded dispatch attempts.
      //
      // The pinned drain is deliberately NOT gated: a pin is authoritative and
      // was resolved against the roster when the child was materialized, so
      // filtering it would strand the job rather than reroute it.
      job =
        (await this.queue.dequeueByPinnedAgent(agentId, agentLabels)) ??
        (await this.queue.dequeueForLabels(
          agentLabels,
          agentMandatoryLabels,
          agentId,
          this.prespawnedFitFilterFor(agentId),
        ));
    } finally {
      if (!job) this.registry.decrementActiveJobs(agentId);
    }
    if (!job) return AgentDrainDecline.NoMatchingJob;

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
    return null;
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

    // Label-routed, exactly like `dispatch()`: the candidates here are idle
    // agents that merely match, not the agent this job was bound to. So the
    // same suitability gate applies — an unsuitable warm agent is dropped and
    // the job falls through to the scaler below. A job-bound agent is never a
    // pre-spawned one, so its own agent can never be filtered out from under it.
    const available = this.filterUnsuitablePrespawned(
      this.registry.findAvailable(
        matchLabelsFor(job),
        job.runsOnPatterns ?? [],
        job.excludeLabels ?? [],
        job.excludePatterns ?? [],
      ),
      job,
    );
    if (available.length > 0) {
      const dispatched = await this.dispatchBoundJob(
        selectAgent(available, job.jobConfig).agentId,
        jobId,
      );
      if (dispatched) return;
    }
    if (this.onNoMatchingAgent) {
      // A requeued container job needs its spawn context too — without it the
      // retry would scale a plain agent for a job that requires its own image.
      const containerSpawn = containerSpawnFor(job.jobConfig);
      await this.onNoMatchingAgent(
        job.runsOnLabels,
        jobId,
        job.runId,
        job.excludeLabels ?? [],
        job.resources,
        typeof job.jobConfig?.cacheOrgId === 'string' ? job.jobConfig.cacheOrgId : undefined,
        containerSpawn,
      );
    }
  }

  /**
   * Safety-net re-drive: deliver every pending job that a currently-connected,
   * idle, matching agent could take, through the same atomic claim the drain
   * uses (`dispatchBoundJob` → `dequeueById`).
   *
   * Runs per-coordinator and is NOT leader-gated: each coordinator drains the
   * shared queue onto its OWN connected agents, and the atomic claim guarantees
   * at most one agent (on any coordinator) wins each job, so concurrent ticks
   * cannot double-dispatch.
   *
   * It closes the requeue re-drive gap. A job requeued by `handleAckExpiry` /
   * `onJobRejected` / the leader ack sweep gets exactly one delivery attempt —
   * `redispatch`'s single `findAvailable` + `dispatchBoundJob`. An idle matching
   * agent whose own drain trigger (registration / completion / status) already
   * fired before the requeue has no further trigger, so if that one attempt
   * transiently misses the agent — the agent is momentarily at capacity while an
   * in-flight drain holds its eagerly-claimed slot, or the agent is connected to
   * a different coordinator than the one that ran the expiry — the requeued
   * pending job would otherwise sit undelivered until it expired. This tick
   * re-attempts delivery onto connected agents so the miss recovers on the next
   * sweep.
   *
   * It never consults the scaler (that is `retryPendingScaleRequests`) and never
   * spawns: it only places jobs onto agents already connected here.
   *
   * A failure propagates to the caller rather than being swallowed here — the
   * per-coord interval wrapper is the single error-log site, matching the
   * sibling recovery/ack sweeps that share its cadence. The `finally` only
   * releases the single-flight guard.
   */
  async redrivePendingToConnectedAgents(maxJobs: number = DEFAULT_REDRIVE_BATCH): Promise<number> {
    if (this.pendingRedriveInFlight || this.isDraining()) return 0;
    this.pendingRedriveInFlight = true;
    try {
      if ((await this.queue.getDepth()) === 0) return 0;
      const pending = await this.queue.listPending(maxJobs);
      let placed = 0;
      for (const job of pending) {
        const target = await this.selectConnectedTargetForPending(job);
        if (!target) continue;
        if (await this.dispatchBoundJob(target, job.id)) placed++;
      }
      if (placed > 0) {
        logger.info('Re-drove pending jobs onto connected idle agents', {
          placed,
          scanned: pending.length,
        });
      }
      return placed;
    } finally {
      this.pendingRedriveInFlight = false;
    }
  }

  /**
   * Pick a connected agent that may take a pending job, or null. A pinned
   * host-fanout child may run ONLY on its pinned agent — and `dequeueById`
   * ignores the pin — so a pinned job is routed to its own agent and never
   * offered to `findAvailable`, which would mis-deliver it to any label match.
   *
   * Reboot-pending gate: a host whose `restart` job just completed is still
   * connected but about to reboot, so its held post-restart job must NOT be
   * re-driven into the about-to-die box. This is the safety-net re-drive's
   * counterpart of the same gate in `dispatch()` / `dispatchPinned` /
   * `drainForAgent`; without it this path re-drives the held job onto the
   * reboot-pending host and defeats the hold.
   */
  private async selectConnectedTargetForPending(job: QueuedJob): Promise<string | null> {
    if (job.pinnedAgentId) {
      const agent = this.registry.get(job.pinnedAgentId);
      if (!agent || agent.activeJobs >= agent.maxConcurrency) return null;
      if ((await this.rosterStore?.isRebootPending(job.pinnedAgentId, Date.now())) ?? false) {
        return null;
      }
      return job.pinnedAgentId;
    }
    const availableRaw = this.registry.findAvailable(
      matchLabelsFor(job),
      job.runsOnPatterns ?? [],
      job.excludeLabels ?? [],
      job.excludePatterns ?? [],
    );
    const available = this.filterUnsuitablePrespawned(
      await this.filterRebootPending(availableRaw),
      job,
    );
    if (available.length === 0) return null;
    return selectAgent(available, job.jobConfig).agentId;
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
      // No in-flight jobs -- clean disconnect. (The common reboot case: the
      // restart job already reported success before the box went down, so there
      // is nothing in-flight; the reboot-pending flag's job here is the
      // drain-gate + clear-on-reconnect, handled elsewhere.)
      this.registry.unregister(agentId);
      this.cleanupGraceEntriesForAgent(agentId);
      await this.updateQueueDepthMetric();
      return [];
    }

    // Reboot-pending disconnect: this disconnect IS the expected reboot. Do not
    // start the recovery→fail timer; instead complete any in-flight started job
    // as success (the safety net for the rare case where the restart job's
    // success report did not flush before the box went down).
    const rebootPending = (await this.rosterStore?.isRebootPending(agentId, Date.now())) ?? false;
    if (rebootPending && !scalerManaged) {
      await this.completeInFlightForReboot(agentId, [...jobIds]);
      this.cleanupGraceEntriesForAgent(agentId);
      this.registry.unregister(agentId);
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

  /**
   * Reboot-pending agent disconnected: complete its in-flight started job(s) as
   * success (the restart job, which already reported success, may already be
   * terminal — `markCompleted` is a no-op / guarded in that case). Never starts
   * a recovery timer. Untracks the jobs so the reconnect does not reconcile a
   * phantom in-flight set.
   */
  private async completeInFlightForReboot(agentId: string, jobIds: string[]): Promise<void> {
    for (const jobId of jobIds) {
      this.resolvePendingAck(jobId);
      const started = this.startedJobs.has(jobId);
      this.untrackJob(agentId, jobId);
      if (!started) continue;
      try {
        await this.queue.markCompleted(jobId);
        logger.info('Reboot-pending agent disconnected; completed in-flight job as success', {
          agentId,
          jobId,
        });
      } catch (err) {
        logger.warn('Failed to complete in-flight job on reboot disconnect (may be terminal)', {
          agentId,
          jobId,
          error: toErrorMessage(err),
        });
      }
    }
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
    await this.queue.markDispatchedIfRecovering(jobId, agentId);
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
