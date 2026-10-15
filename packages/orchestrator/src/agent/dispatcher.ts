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
import {
  agentMayRefuse,
  canAgentRunJob,
  fitAgentFor,
  jobContainerNeed,
  type AgentFitJob,
  type FitAgent,
  type ScalerAgentView,
} from '../scaler/agent-fit.js';
import { canonicalizeLabels, canonicalizeMatcher, JobRejectReason } from '@kici-dev/engine';
import type { ResourceRequest, RunsOnPick } from '@kici-dev/engine';
import { agentHasFreeSlot, BusyHoldOutcome, type AgentEntry } from './registry.js';
import { requestContext, createLogger, toErrorMessage } from '@kici-dev/shared';
import { dispatchOwnershipSkippedTotal } from '../metrics/prometheus.js';

const logger = createLogger({ prefix: 'dispatcher' });

/**
 * Why a freed agent's queue drain claimed nothing: one member per way
 * `Dispatcher.drainForAgent` returns without a dispatch. Named because the value
 * travels: it is the drain-declined log line's `reason` and the tests' subject.
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
 * What claiming one specific queued job for an agent came to. `NotSent` is a
 * claim that did not reach the agent: the dispatch was refused and the job failed, or this coordinator could not open the job's sealed
 * secrets and put the job back or failed it. The claim dealt with the job, so a
 * caller must neither scale for it nor count it as placed.
 */
enum BoundClaimOutcome {
  /** Claimed and sent to the agent. */
  Sent = 'sent',
  /** Claimed, then refused or put back rather than sent. */
  NotSent = 'not-sent',
  /** Nothing claimed: the agent is gone, full or draining, or the job is no longer claimable. */
  NotClaimed = 'not-claimed',
}

/**
 * Default per-pass cap on pending jobs a capacity-freed re-drive re-offers, so
 * one free event cannot storm the scaler. The per-backend spawn semaphore bounds
 * provisioning; a job that gets `at-capacity` again stays pending for the next tick.
 */
export const DEFAULT_REDRIVE_BATCH = 10;

/**
 * Pick the agent for a label-routed job, per `runsOn.pick` (`jobConfig.runsOnPick`):
 * - `deterministic` (the default, and any unset value): lowest `agentId`, so a
 *   run-once-on-one-host job (a migration, a dump) lands on the same host across re-runs.
 * - `any`: the first available candidate (load spread).
 *
 * `available` is never empty (callers guard `available.length > 0`).
 */
function selectAgent(available: AgentEntry[], jobConfig: Record<string, unknown>): AgentEntry {
  const pick = jobConfig.runsOnPick as RunsOnPick | undefined;
  if (pick === 'any') return available[0];
  return [...available].sort((a, b) => a.agentId.localeCompare(b.agentId))[0];
}

/** Dispatch metrics, injected so the dispatcher does not import the metrics module. */
export interface DispatchMetrics {
  incJobsDispatched(status: 'dispatched' | 'queued' | 'rejected'): void;
  setQueueDepth(depth: number): void;
  /** Record `count` pending jobs re-driven through the scaler by `trigger`. */
  incScalerRedispatch(trigger: ScalerRedispatchTrigger, count: number): void;
}

/**
 * Slice of `HostRosterStore` for the host-restart flow: an interface so the
 * dispatcher avoids importing the full store (it pulls in engine label matchers)
 * and the reboot logic is testable with an in-memory stub.
 */
export interface HostRosterRebootStore {
  /** True when the host's reboot-pending deadline is still in the future. */
  isRebootPending(agentId: string, nowMs: number): Promise<boolean>;
  /** Clear the reboot-pending flag (down-then-up release on reconnect). */
  clearRebootPending(agentId: string): Promise<void>;
}

/**
 * `duplicate`: the dispatch_queue row for a preassigned (rerouted) jobId already
 * existed, so the claimed slot is released, onDispatch is NOT called, and the
 * reroute caller treats the job as handled. Only a reroute re-dispatch reaches
 * it; first dispatch uses a fresh UUID that cannot collide.
 *
 * `queued` also answers a direct dispatch refused because the job's run has
 * stopped: the queue row is recorded `expired` and the job cancelled, the
 * state a cancel leaves a queued job of its run in.
 */
type DispatchResult =
  | { status: 'dispatched'; agentId: string; jobId: string }
  | { status: 'queued'; jobId: string }
  | { status: 'queued-no-backend'; jobId: string }
  | { status: 'duplicate'; jobId: string }
  | { status: 'rejected'; reason: string };

/**
 * Labels a job needs from a REGISTERED agent beyond its `runsOn`: a
 * `container.dockerfile` job also needs `kici:runtime:container-build`
 * (agent-self-reported). Not applied to the scaler consult: a backend is chosen by
 * exact label-set containment, so a label no pool declares would strand the job
 * `queued-no-backend` instead of spawning anything.
 */
function matchLabelsFor(job: {
  runsOnLabels: string[];
  jobConfig?: Record<string, unknown> | undefined;
}): string[] {
  const extra = requiredRuntimeLabelsFor(job.jobConfig?.container);
  return extra.length === 0 ? job.runsOnLabels : [...job.runsOnLabels, ...extra];
}

/**
 * The job's container spawn, from what dispatch already resolved on `jobConfig`:
 * `container` from the lock, `containerRegistryAuth` orchestrator-side. Nothing
 * is re-resolved — a second resolution is a second chance to disagree.
 *
 * A job that BUILDS its image (`container.dockerfile`) carries no `image`, so this
 * returns `undefined` and no per-job-image spawn happens. Load bearing: the image
 * does not exist until an agent clones and builds it, so an ordinary agent must
 * run the job and nest the container. Exported so `dispatcher.test.ts` pins this
 * routing decision.
 */
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

/**
 * What an `onDispatch` callback returns when it refuses to put a job on the
 * wire. The dispatcher fails the job permanently with `refused` as the reason
 * instead of arming an ack deadline for a message that was never sent.
 */
export interface DispatchRefusal {
  refused: string;
}

/** The callback that sends a dispatched job to its agent. */
export type OnDispatch = (
  agentId: string,
  job: QueuedJob,
) => void | DispatchRefusal | Promise<void | DispatchRefusal>;

/**
 * Dispatch coordinator: routes jobs to label-matching agents, falling back to the
 * persistent queue, and handles agent connect, disconnect and job completion.
 *
 * It never touches WebSocket connections: the caller (orchestrator-core.ts or worker-core.ts)
 * provides an onDispatch that looks up the agent's WS in the registry and sends
 * the job.dispatch message.
 */
export class Dispatcher {
  private readonly registry: AgentRegistry;
  private readonly queue: JobQueue;
  private readonly metrics: DispatchMetrics;
  private readonly onDispatch: OnDispatch;
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
  private readonly scalerAgentView?: ((agentId: string) => ScalerAgentView | undefined) | undefined;

  /**
   * Single-flight guard for `retryPendingScaleRequests`: the capacity-freed hook
   * and the leader-gated sweep can fire concurrently and must not double-offer
   * the same pending jobs to the scaler in one tick.
   */
  private redriveInFlight = false;

  /**
   * Single-flight guard for `redrivePendingToConnectedAgents`: the next interval
   * fire must not re-enter a slow re-drive and double-scan the same pending rows.
   */
  private pendingRedriveInFlight = false;

  /** agentId -> dispatched jobIds, for failing jobs on agent disconnect. */
  private readonly agentJobs = new Map<string, Set<string>>();

  /** Reverse map: jobId -> agentId, for cancel-run lookups. */
  private readonly jobToAgent = new Map<string, string>();

  /**
   * jobId -> runId, kept and cleared with `jobToAgent`/`agentJobs`, so the
   * provenance token relay resolves a job's runId from dispatcher state
   * (`resolveOwnedJob`) rather than trusting an agent-asserted value.
   */
  private readonly jobRunIds = new Map<string, string>();

  /**
   * Grace window for recently completed jobs: late messages (log.chunk,
   * step.status) are accepted briefly after completion, not flagged as
   * ownership violations.
   */
  private readonly completedJobs = new Map<string, { agentId: string; expiresAt: number }>();

  /** Bounds completedJobs growth. */
  private static readonly COMPLETED_JOBS_CAP = 10_000;

  private static readonly GRACE_WINDOW_MS = 30_000;

  private static readonly GRACE_CLEANUP_INTERVAL_MS = 10_000;

  private graceCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** From agent config; derives the recovery grace period. */
  private readonly maxReconnectDelayMs: number;

  /**
   * Fired on a permanent dispatch-side failure (recovery window expired,
   * re-dispatch attempts exhausted, or a scaler-managed agent destroyed
   * mid-execution); the receiver marks the execution-tracker job failed.
   */
  private readonly onJobFailedPermanently?:
    ((agentId: string, jobId: string, runId: string, reason: string) => void) | undefined;

  private readonly onRecoveryStarted?: ((agentId: string, jobId: string) => void) | undefined;

  /** Fallback ack deadline when no getAckTimeoutMs dep is wired (tests). */
  private static readonly DEFAULT_ACK_TIMEOUT_MS = 10_000;

  /**
   * Pending dispatch acks: armed when a job.dispatch is sent, resolved by
   * job.ack / job.reject / job.status running / disconnect triage. On expiry the
   * dispatch is lost: requeue + disconnect.
   */
  private readonly pendingAcks = new Map<
    string,
    { agentId: string; runId: string; timer: ReturnType<typeof setTimeout> }
  >();

  /**
   * jobId -> acking agent, for acks that beat their pending-ack entry (the agent
   * answered before the timeout was resolved and the deadline stamped).
   * `armAckDeadline` consumes it and skips arming.
   */
  private readonly earlyAcks = new Map<string, string>();

  /** Per-job ack deadline (per-org override / cluster default). */
  private readonly getAckTimeoutMs: (job: QueuedJob) => Promise<number>;

  /** Cancel + disconnect an agent whose dispatch ack deadline expired. */
  private readonly onAckTimeout?:
    ((agentId: string, jobId: string, runId: string) => void) | undefined;

  /**
   * Jobs whose `job.status: running` arrived. Disconnect triage re-dispatches
   * never-started jobs; started jobs on destroyed agents fail fast.
   */
  private readonly startedJobs = new Set<string>();

  /**
   * Recovery timers for 'recovering' jobs: each in-flight job of a disconnected
   * agent gets one, cancelled if the agent reconnects before it fires.
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

  private get gracePeriodMs(): number {
    return this.maxReconnectDelayMs * 2;
  }

  /** For the reboot-pending gate; undefined ⇒ flow inert. */
  private readonly rosterStore?: HostRosterRebootStore;

  /** When true, new jobs queue Pending instead of dispatching. Defaults to never. */
  private readonly isDraining: () => boolean;

  /** Defaults to none (a single node). */
  private readonly hasPeerCoordinators: () => boolean | Promise<boolean>;

  constructor(deps: {
    registry: AgentRegistry;
    queue: JobQueue;
    metrics: DispatchMetrics;
    onDispatch: OnDispatch;
    /** Called when no agent matches; gets the per-job `resources` so the scaler
     *  applies per-scaler / per-orchestrator / per-machine caps before spawning. */
    onNoMatchingAgent?: (
      labels: string[],
      jobId: string,
      runId: string,
      excludeLabels: string[],
      resources?: ResourceRequest,
      orgId?: string,
      /**
       * The job's own image plus registry credentials, resolved at dispatch.
       * Present: the backend spawns THAT image with the KiCI runtime injected
       * instead of the pool's fixed agent image.
       */
      containerSpawn?: ResolvedContainerSpawn,
    ) => Promise<ScaleResult>;
    /**
     * What the scaler knows about an agent it started (`ScalerManager.agentView`),
     * undefined for others. Feeds `canAgentRunJob`: the job the agent was started
     * for, whether it runs in that job's image, a warm agent's fixed shape. Absent
     * with no scaler; every agent is then judged on its own registration.
     */
    scalerAgentView?: (agentId: string) => ScalerAgentView | undefined;
    /** From agent config (default 60s); derives the grace period. */
    maxReconnectDelayMs?: number;
    /** Fired when a job is permanently failed before/outside agent execution. */
    onJobFailedPermanently?: (
      agentId: string,
      jobId: string,
      runId: string,
      reason: string,
    ) => void;
    /** Fired when a job enters recovery (its timer starts). */
    onRecoveryStarted?: (agentId: string, jobId: string) => void;
    /** Per-job dispatch-ack deadline (ms). Defaults to 10s. */
    getAckTimeoutMs?: (job: QueuedJob) => Promise<number>;
    /** Cancel + disconnect an agent whose dispatch ack deadline expired. */
    onAckTimeout?: (agentId: string, jobId: string, runId: string) => void;
    /**
     * For the host-restart flow: no pinned drain to a reboot-pending agent, and
     * its disconnect is the expected reboot (in-flight job completes success, no
     * recovery-fail timer). Omitted ⇒ inert (every host reads not-pending).
     */
    rosterStore?: HostRosterRebootStore;
    /** When true, dispatch() enqueues new jobs Pending and onAgentAvailable()
     *  claims nothing; jobs already on agents finish. Defaults to never. */
    isDraining?: () => boolean;
    /**
     * Whether another coordinator is live: connected, or disconnected for less
     * than the peer flap grace. A job whose sealed secrets this coordinator
     * cannot open is put back for such a peer; with none, no coordinator can
     * open it, so it fails at once. Defaults to none.
     */
    hasPeerCoordinators?: () => boolean | Promise<boolean>;
  }) {
    this.registry = deps.registry;
    this.queue = deps.queue;
    this.metrics = deps.metrics;
    this.onDispatch = deps.onDispatch;
    this.onNoMatchingAgent = deps.onNoMatchingAgent;
    this.scalerAgentView = deps.scalerAgentView;
    this.isDraining = deps.isDraining ?? (() => false);
    this.hasPeerCoordinators = deps.hasPeerCoordinators ?? (() => false);
    this.maxReconnectDelayMs = deps.maxReconnectDelayMs ?? 60_000;
    this.onJobFailedPermanently = deps.onJobFailedPermanently;
    this.onRecoveryStarted = deps.onRecoveryStarted;
    this.getAckTimeoutMs = deps.getAckTimeoutMs ?? (async () => Dispatcher.DEFAULT_ACK_TIMEOUT_MS);
    this.onAckTimeout = deps.onAckTimeout;
    this.rosterStore = deps.rosterStore;
    // An agent the registry drops on its own (a revoked or expired token)
    // gets the same job triage as one whose socket closes.
    this.registry.setDisconnectTriage((agentId) => this.onAgentDisconnect(agentId));
  }

  /** Runs with the ids of the jobs each disconnect triage failed; see {@link setDisconnectCleanup}. */
  private disconnectCleanup?: (failedJobIds: string[]) => void;

  /**
   * The agent WS handler installs the release of the failed jobs' in-memory
   * waiters (pending builds, inits, dynamic evaluations, global eval rounds). It
   * runs inside {@link onAgentDisconnect}, so paths that drop an agent without
   * its socket closing (heartbeat timeout, ack timeout, token revocation) reach it.
   */
  setDisconnectCleanup(cleanup: (failedJobIds: string[]) => void): void {
    this.disconnectCleanup = cleanup;
  }

  /** Dispatch a job to a matching agent, or queue it; 'rejected' when the queue is full. */
  async dispatch(job: QueuedJobInput): Promise<DispatchResult> {
    // Host-fanout pin: only the pinned agent, or queue with the pin until it is
    // free/reconnects. Never falls through to another agent.
    if (job.pinnedAgentId) {
      return this.dispatchPinned(job);
    }

    // Coordinator draining: no send, no spawn. Every new job (a new run's first
    // or an in-flight run's ready downstream) enqueues Pending for the fresh
    // coordinator after the upgrade restart (Model A / job-level drain); only jobs already
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

    // Reboot-pending gate (label-routed path): a `restartHost()` workflow pins the
    // post-restart job to its host via `runsOn: 'kici:host:<id>'`, and that job
    // reaches THIS path (not dispatchPinned) once its `needs` are met. Excluding
    // reboot-pending agents holds it queued until the reconnect clears the flag
    // and onAgentAvailable drains it.
    //
    // Suitability gate: a scaler agent that cannot run this job (started inside
    // another job's image, no container runtime for a container job, a warm agent
    // of another shape) is dropped too, so the job reaches the scale path below.
    const notRebooting = await this.filterRebootPending(availableRaw);
    const available = this.filterUnservableAgents(notRebooting, job, job.jobId);
    if (available.length === 0 && notRebooting.length > 0) {
      logger.info('Label-matching agents cannot run this job', {
        runId: job.runId,
        jobName: job.jobName,
        container: jobContainerNeed(job.jobConfig?.container),
        refusedAgents: notRebooting.map((a) => a.agentId),
      });
    }

    if (available.length > 0) {
      const agent = selectAgent(available, job.jobConfig);

      // Claim the slot before the async insert (same race as onAgentAvailable).
      this.registry.incrementActiveJobs(agent.agentId);
      let insertResult: { id: string; inserted: boolean; runStopped?: boolean };
      try {
        // Persisted for the audit trail, failing on agent disconnect, and state
        // recovery after restart. Idempotent on the primary key: a rerouted jobId
        // a sibling coordinator (or an earlier reroute) wrote is a no-op, not a
        // pkey error.
        insertResult = await this.queue.insertDispatched(job, agent.agentId);
      } catch (err) {
        this.registry.decrementActiveJobs(agent.agentId);
        throw err;
      }
      if (!insertResult.inserted) {
        // Tracked elsewhere: release the slot, report the benign duplicate, never
        // double-dispatch. Only a preassigned (rerouted) jobId reaches this.
        this.registry.decrementActiveJobs(agent.agentId);
        logger.info('Reroute re-dispatch no-op — job already present in dispatch_queue', {
          runId: job.runId,
          jobId: insertResult.id,
          jobName: job.jobName,
        });
        return { status: 'duplicate', jobId: insertResult.id };
      }
      if (insertResult.runStopped) {
        return this.refuseStoppedRunDispatch(agent.agentId, job, insertResult.id);
      }
      const jobId = insertResult.id;

      const queuedJob: QueuedJob = {
        id: jobId,
        runId: job.runId,
        workflowName: job.workflowName,
        jobName: job.jobName,
        // Direct dispatch never round-trips the row, so this is the only place
        // these selectors are folded on this path — the same fold
        // `rowToQueuedJob` applies to a job that does go through the queue.
        runsOnLabels: canonicalizeLabels(job.runsOnLabels),
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
        sourceTarDigest: job.sourceTarDigest,
        depsUrl: job.depsUrl,
        depsHash: job.depsHash,
        requestId: job.requestId,
        excludeLabels: canonicalizeLabels(job.excludeLabels ?? []),
        runsOnPatterns: (job.runsOnPatterns ?? []).map(canonicalizeMatcher),
        excludePatterns: (job.excludePatterns ?? []).map(canonicalizeMatcher),
        routingKey: job.routingKey,
        resources: job.resources,
      };

      this.trackJobForAgent(agent.agentId, jobId, queuedJob.runId);
      let sent: boolean;
      try {
        sent = await this.deliver(agent.agentId, queuedJob);
      } catch (err) {
        // Not sent: free the agent; the caller owns the job after a throw. The
        // row stays dispatched with no ack deadline; the stale-dispatch scan
        // settles it.
        this.releaseTrackedClaim(agent.agentId, jobId);
        throw err;
      }
      // Armed only once sent, so the deadline excludes the secret-merge /
      // token-mint prep.
      if (sent) {
        await this.armAckDeadline(agent.agentId, queuedJob);
        this.metrics.incJobsDispatched('dispatched');
      }

      return { status: 'dispatched', agentId: agent.agentId, jobId };
    }

    // No agent: enqueue first for a stable jobId. The scaler binds it to the
    // agent it spawns, so registration eagerly dispatches this exact job there,
    // skipping the generic queue-drain race the 5s scaler-managed agent idle
    // timer otherwise wins.
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

    if (this.onNoMatchingAgent) {
      const containerSpawn = containerSpawnFor(job.jobConfig);
      const scaleResult = await this.onNoMatchingAgent(
        job.runsOnLabels,
        jobId,
        job.runId,
        job.excludeLabels ?? [],
        // Same reading as the fit gate: the typed mirror is optional on a
        // caller-built input (not a queue row). Resources apply only at spawn,
        // so a shape read as absent here starts the agent at the label-set
        // default, a size the job did not ask for.
        job.resources ?? resourcesFromJobConfig(job.jobConfig),
        typeof job.jobConfig?.cacheOrgId === 'string' ? job.jobConfig.cacheOrgId : undefined,
        containerSpawn,
      );

      // An agent that matches the labels but can never run the job (a
      // container job on an agent with no runtime) does not count.
      // fails-when: a container job whose only matching agents report no
      // runtime stays queued here instead of being offered to a peer
      const fit = this.agentFitFor(job, job.jobId);
      if (
        scaleResult.action === 'no-backend' &&
        !this.registry.hasMatchingAgent(
          job.runsOnLabels,
          job.runsOnPatterns ?? [],
          job.excludeLabels ?? [],
          job.excludePatterns ?? [],
          (entry) => canAgentRunJob(this.fitAgentFor(entry), fit),
        )
      ) {
        // No backend AND no registered agent: the job stays queued (expires on
        // timeout) as the fallback while queued-no-backend lets the coordinator
        // try peer rerouting. The log (selectors vs every agent's labels and
        // capacity) tells label mismatch, at-capacity and no-agent apart without
        // a re-run.
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
      // 'spawning': agent registration triggers dispatchBoundJob(). 'at-capacity',
      // 'failed', and 'no-backend' with a matching busy agent: the job waits in
      // the queue for an existing agent to free up.
    }

    return { status: 'queued', jobId };
  }

  /**
   * Re-drive the scaler for jobs still pending after `at-capacity`, from the
   * capacity-freed hook (`ScalerManager.onCapacityFreed`) and the leader-gated
   * `PendingScaleSweeper`. Oldest first (FIFO: the longest-waiting burst victim
   * gets the freed slot), through the SAME `onNoMatchingAgent` → `requestScale`
   * path as dispatch, so it inherits the spawn semaphore and cap accounting. A
   * job that gets `at-capacity` again stays pending for the next tick — no retry
   * state, no backoff.
   *
   * Single-flight (an overlapping call returns 0, so hook+sweep never double-offer)
   * and bounded by `maxJobs`. A job whose sealed secrets this coordinator cannot
   * open is settled instead ({@link settleUnopenablePending}).
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
        if ((await this.offerPendingToScaler(job)) === 'spawning') redriven++;
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
   * Re-offer ONE pending job to the scaler when a worker's spawn-retry backoff
   * ends. Outside the batch single-flight on purpose: a wake-up during a batch
   * pass would be dropped, and a worker runs no pending-scale sweep. The worker's
   * per-job attempt gate prevents a second spawn for the same job.
   *
   * @returns true when a spawn started.
   */
  async redrivePendingJob(jobId: string): Promise<boolean> {
    if (!this.onNoMatchingAgent) return false;
    const job = await this.queue.getFullJobById(jobId);
    if (!job || job.status !== DispatchQueueStatus.Pending) return false;
    return (await this.offerPendingToScaler(job)) === 'spawning';
  }

  /**
   * Offer one pending job via the dispatch scale path, or settle it when its
   * sealed secrets cannot be opened here.
   */
  private async offerPendingToScaler(job: QueuedJob): Promise<ScaleResult['action'] | 'settled'> {
    // fails-when: the re-drive spawns a job's private image without its sealed registry credentials
    // breaks-if-wrong: a job whose secrets opened is still offered to the scaler
    if (job.secretsUnavailable) {
      await this.settleUnopenablePending(job, job.secretsUnavailable);
      return 'settled';
    }
    if (!this.onNoMatchingAgent) return 'settled';
    const result = await this.onNoMatchingAgent(
      job.runsOnLabels,
      job.id,
      job.runId,
      job.excludeLabels ?? [],
      job.resources,
      typeof job.jobConfig?.cacheOrgId === 'string' ? job.jobConfig.cacheOrgId : undefined,
      containerSpawnFor(job.jobConfig),
    );
    return result.action;
  }

  /**
   * Release the slot of a direct dispatch the queue refused because the run has
   * stopped; nothing is sent. The queue already recorded the row `expired` and
   * cancelled the job, so it reads as a queued job the cancel expired, and the
   * caller tracks it under `queued` the same way.
   */
  private refuseStoppedRunDispatch(
    agentId: string,
    job: QueuedJobInput,
    jobId: string,
  ): DispatchResult {
    this.registry.decrementActiveJobs(agentId);
    logger.info('Direct dispatch not sent: the run has stopped', {
      runId: job.runId,
      jobId,
      jobName: job.jobName,
      agentId,
    });
    return { status: 'queued', jobId };
  }

  /**
   * Dispatch a host-fanout pinned child to exactly `job.pinnedAgentId` when it is
   * locally connected, passes the runsOn/exclude/mandatory gate and has capacity;
   * otherwise queue it WITH the pin for the pin-aware drain when the agent frees
   * up or (re)connects. Never falls through to a different agent.
   */
  private async dispatchPinned(job: QueuedJobInput): Promise<DispatchResult> {
    const agentId = job.pinnedAgentId!;
    const agent = this.registry.get(agentId);
    // Reboot-pending gate: a host whose `restart` job just completed is still
    // connected but about to reboot, so its pinned post-restart job (here once
    // the restart satisfies its `needs`) queues with the pin for the
    // down-then-up reconnect. Direct-dispatch counterpart of onAgentAvailable's gate.
    const rebootPending = (await this.rosterStore?.isRebootPending(agentId, Date.now())) ?? false;
    const dispatchable =
      // Coordinator draining: even a pinned job queues with its pin, for the
      // fresh coordinator after the upgrade restart.
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
      agentHasFreeSlot(agent);

    if (dispatchable) {
      this.registry.incrementActiveJobs(agentId);
      let insertResult: { id: string; inserted: boolean; runStopped?: boolean };
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
      if (insertResult.runStopped) {
        return this.refuseStoppedRunDispatch(agentId, job, insertResult.id);
      }
      const jobId = insertResult.id;
      const queuedJob: QueuedJob = {
        id: jobId,
        runId: job.runId,
        workflowName: job.workflowName,
        jobName: job.jobName,
        // Direct dispatch never round-trips the row, so this is the only place
        // these selectors are folded on this path — the same fold
        // `rowToQueuedJob` applies to a job that does go through the queue.
        runsOnLabels: canonicalizeLabels(job.runsOnLabels),
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
        sourceTarDigest: job.sourceTarDigest,
        depsUrl: job.depsUrl,
        depsHash: job.depsHash,
        requestId: job.requestId,
        excludeLabels: canonicalizeLabels(job.excludeLabels ?? []),
        runsOnPatterns: (job.runsOnPatterns ?? []).map(canonicalizeMatcher),
        excludePatterns: (job.excludePatterns ?? []).map(canonicalizeMatcher),
        routingKey: job.routingKey,
        resources: job.resources,
        pinnedAgentId: agentId,
      };
      this.trackJobForAgent(agentId, jobId, queuedJob.runId);
      let sent: boolean;
      try {
        sent = await this.deliver(agentId, queuedJob);
      } catch (err) {
        // Same as the label-routed path above.
        this.releaseTrackedClaim(agentId, jobId);
        throw err;
      }
      if (sent) {
        await this.armAckDeadline(agentId, queuedJob);
        this.metrics.incJobsDispatched('dispatched');
      }
      return { status: 'dispatched', agentId, jobId };
    }

    // Pinned agent absent / busy: the pin-aware drain (dequeueByPinnedAgent on
    // register / onAgentAvailable) delivers it once the agent is live with capacity.
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
   * Eagerly dispatch the job the scaler bound at spawn time to a freshly
   * registered scaler-managed agent (the agent-handler calls it right after
   * registration). Atomically claims it (still pending, labels still satisfied),
   * marks it dispatched and sends it.
   *
   * True only when sent. False when nothing was claimed (claimed elsewhere,
   * expired, agent unregistered or full, coordinator draining) or the claimed
   * job was not sent (refused and failed, or sealed secrets this coordinator
   * cannot open). On false the caller falls back to the onAgentAvailable() drain.
   */
  async dispatchBoundJob(agentId: string, jobId: string): Promise<boolean> {
    return (await this.claimBoundJob(agentId, jobId)) === BoundClaimOutcome.Sent;
  }

  /** {@link dispatchBoundJob}, reporting whether the job was claimed apart from whether it was sent. */
  private async claimBoundJob(agentId: string, jobId: string): Promise<BoundClaimOutcome> {
    const agent = this.registry.get(agentId);
    if (!agent) return BoundClaimOutcome.NotClaimed;
    if (!agentHasFreeSlot(agent)) return BoundClaimOutcome.NotClaimed;

    // Coordinator draining: the bound job stays Pending for the fresh
    // coordinator after the upgrade restart.
    if (this.isDraining()) return BoundClaimOutcome.NotClaimed;

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
    if (!job) return BoundClaimOutcome.NotClaimed;

    const sent = await this.sendClaimedJob(agentId, job);
    await this.updateQueueDepthMetric();

    // fails-when: a claimed job that was refused or put back reads as sent, and counts as a placement
    // breaks-if-wrong: a claimed job that reached the agent still reads as sent
    return sent ? BoundClaimOutcome.Sent : BoundClaimOutcome.NotSent;
  }

  /**
   * Drop reboot-pending agents, so label-routed dispatch never sends a
   * post-restart job to a host about to reboot. No-op with no roster store.
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
   * Drop the agents that cannot run this job (`canAgentRunJob`): like
   * {@link filterRebootPending}, a reason labels cannot express (started inside
   * another job's image, no container runtime for a container job, a warm agent
   * of another shape). Dropping them sends the job down the `onNoMatchingAgent`
   * scale path. `jobId` (the queue id, when any) is how the agent started for
   * the job recognizes it.
   */
  private filterUnservableAgents<T extends AgentEntry>(
    agents: T[],
    job: { resources?: ResourceRequest; jobConfig?: Record<string, unknown> | undefined },
    jobId: string | undefined,
  ): T[] {
    if (agents.length === 0) return agents;
    const fit = this.agentFitFor(job, jobId);
    return agents.filter((a) => canAgentRunJob(this.fitAgentFor(a), fit));
  }

  /** The registration facts, and the scaler's record, `canAgentRunJob` judges an agent on. */
  private fitAgentFor(agent: AgentEntry): FitAgent {
    return fitAgentFor(agent, this.scalerAgentView);
  }

  /**
   * The fit question for one job: queue id, declared shape, and what its
   * `container:` asks of the host.
   *
   * The shape falls back to `jobConfig.resources` because the typed `resources`
   * mirror is optional and several paths never fill it: a job reaching {@link dispatch}
   * off the webhook pipeline or a worker's reroute handler declares in
   * `jobConfig` alone. Reading only the mirror admits it onto a pre-spawned agent
   * of another size — the mismatch this gate exists to refuse.
   */
  private agentFitFor(
    job: { resources?: ResourceRequest; jobConfig?: Record<string, unknown> | undefined },
    jobId: string | undefined,
  ): AgentFitJob {
    const declared = job.resources ?? resourcesFromJobConfig(job.jobConfig);
    return {
      ...(jobId !== undefined ? { jobId } : {}),
      ...(declared ? { resources: declared } : {}),
      container: jobContainerNeed(job.jobConfig?.container),
    };
  }

  /**
   * The queue-drain half of {@link filterUnservableAgents}: a per-job predicate
   * for one agent, or undefined for an agent that runs any job — a predicate
   * that only says yes would cost the drain its single-statement fast path.
   */
  private agentFitFilterFor(agent: AgentEntry): ((job: QueuedJob) => boolean) | undefined {
    const fitAgent = this.fitAgentFor(agent);
    if (!agentMayRefuse(fitAgent)) return undefined;
    return (job) => canAgentRunJob(fitAgent, this.agentFitFor(job, job.id));
  }

  /**
   * Clear a reboot-pending host's flag on its real (down-then-up) reconnect, so
   * the next `onAgentAvailable` drain dispatches the held post-restart job. Call
   * ONLY from the (re-)register path, never from a still-connected drain trigger
   * (job completion / agent.status), which must keep the gate closed.
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

  /**
   * Try draining the queue for a specific agent. Called when an agent registers,
   * completes a job or reports `agent.status`; claims at most one queued job per
   * call ({@link drainForAgent}).
   */
  async onAgentAvailable(agentId: string): Promise<void> {
    // The per-agent drain claims directly, not through `findAvailable`, so
    // without this it would route around the draining exclusion and hand a job
    // to an agent being torn down.
    if (this.registry.get(agentId)?.draining === true) return;

    const declined = await this.drainForAgent(agentId);
    const depth = await this.queue.getDepth();
    this.metrics.setQueueDepth(depth);

    // A decline on an EMPTY queue is the steady state; one while work waits is
    // the shape of a job stranded where an agent could take it (a pinned,
    // label-matching job undrained after a host reconnect), which must be told
    // apart from an idle orchestrator. Gated on a non-empty queue so an idle
    // fleet stays quiet; `info` because a deployment at `debug` is not the one
    // that needs the answer.
    if (declined !== null && depth > 0) {
      logger.info('Agent drain declined while the queue is non-empty', {
        agentId,
        reason: declined,
        queueDepth: depth,
      });
    }
  }

  /** Claim at most one queued job for a freed agent; null when one was dispatched. */
  private async drainForAgent(agentId: string): Promise<AgentDrainDecline | null> {
    const agent = this.registry.get(agentId);
    if (!agent) return AgentDrainDecline.NotRegistered;

    if (this.isDraining()) return AgentDrainDecline.CoordinatorDraining;

    const agentLabels = [...agent.labels];
    const agentMandatoryLabels = [...agent.mandatoryLabels];

    // Reboot-pending gate: the host is still connected but about to reboot, so
    // its pinned post-restart job stays held. The down-then-up reconnect clears
    // the flag before its onAgentAvailable runs, so release follows the real
    // reboot, not the still-connected window after the restart job completes.
    const rebootPending = (await this.rosterStore?.isRebootPending(agentId, Date.now())) ?? false;

    if (!agentHasFreeSlot(agent)) return AgentDrainDecline.NoCapacity;
    if (rebootPending) return AgentDrainDecline.RebootPending;

    // Claim the slot before the async dequeue: drain triggers (job completion,
    // agent.status, registration) race, and without the eager claim each passes
    // the capacity check and dispatches to the same single-slot agent.
    this.registry.incrementActiveJobs(agentId);
    let job: QueuedJob | null = null;
    try {
      // Pinned host-fanout children for THIS agent first (they can only run
      // here), then the generic label drain (excludes jobs pinned elsewhere).
      //
      // The generic drain mirrors `dispatch()`, so the same suitability gate
      // applies: otherwise an `agent.status` tick hands a scaler agent the job
      // `dispatch()` just refused it, and an agent started inside one job's image
      // drains unrelated jobs. It goes into the claim, not after it: a
      // claimed-then-released row is stranded Dispatched for a window and burns
      // one of the job's bounded dispatch attempts.
      //
      // The pinned drain is deliberately NOT gated: a pin is authoritative,
      // resolved against the roster when the child was materialized, so
      // filtering would strand the job rather than reroute it.
      job =
        (await this.queue.dequeueByPinnedAgent(agentId, agentLabels)) ??
        (await this.queue.dequeueForLabels(
          agentLabels,
          agentMandatoryLabels,
          agentId,
          this.agentFitFilterFor(agent),
        ));
    } finally {
      if (!job) this.registry.decrementActiveJobs(agentId);
    }
    if (!job) return AgentDrainDecline.NoMatchingJob;

    await this.sendClaimedJob(agentId, job);
    return null;
  }

  /** {@link deliver} inside the job's own request context, restored for a queue-drained job. */
  private async deliverInRequestContext(agentId: string, job: QueuedJob): Promise<boolean> {
    if (!job.requestId) return this.deliver(agentId, job);
    return requestContext.run({ requestId: job.requestId, runId: job.runId }, () =>
      this.deliver(agentId, job),
    );
  }

  /**
   * Hand a tracked job to `onDispatch`. False when not sent: the callback
   * refused it (failed permanently — the refusal is a fact about the job, so
   * another agent would refuse it too), or this coordinator cannot open its
   * sealed secrets (put back for a key holder, or failed when none can:
   * {@link releaseUnopenableDispatch}).
   */
  private async deliver(agentId: string, job: QueuedJob): Promise<boolean> {
    // fails-when: a queued job whose sealed secrets cannot be decrypted is sent without them
    // breaks-if-wrong: a job whose secrets decrypted, or that had none, must still be sent
    if (job.secretsUnavailable) {
      await this.releaseUnopenableDispatch(agentId, job, job.secretsUnavailable);
      return false;
    }
    const outcome = await this.onDispatch(agentId, job);
    if (!outcome) return true;
    // fails-when: a refused job is left dispatched with an ack deadline, or requeued
    // breaks-if-wrong: a callback returning nothing must still count as sent
    await this.failRefusedDispatch(agentId, job, outcome.refused);
    return false;
  }

  /**
   * Handle a claimed job sealed with a master key this coordinator does not hold.
   *
   * With a peer live it is not permanent: mid rolling master-key rotation the
   * peer may hold the new key and its drains can take the job. The row returns
   * to pending, spending one dispatch attempt and recording the reason as the
   * provisioning error (what an expiry reports), and this coordinator stops
   * offering it for the sealed-secrets back-off. After that, drains and re-drives
   * offer it again, so a job no coordinator opens fails with the reason at
   * {@link MAX_DISPATCH_ATTEMPTS}. With no peer live it fails at once.
   *
   * `agentId` is undefined when a re-drive claimed it for no agent
   * ({@link settleUnopenablePending}).
   */
  private async releaseUnopenableDispatch(
    agentId: string | undefined,
    job: QueuedJob,
    reason: string,
  ): Promise<void> {
    // fails-when: a single node keeps a job it can never open pending until it expires
    // breaks-if-wrong: with a peer coordinator connected, the job is put back for it
    if (!(await this.hasPeerCoordinators())) {
      await this.failRefusedDispatch(agentId, job, reason);
      return;
    }
    this.releaseClaimAccounting(agentId, job.id);
    // Armed before the row returns to pending: a drain racing the requeue would
    // otherwise find the job claimable inside its back-off.
    // fails-when: a concurrent drain re-claims the job between the requeue and the deferral
    await this.queue.deferUnopenable(job.id);
    const attempts = await this.queue.requeue(job.id, {
      countAttempt: true,
      provisioningError: reason,
    });
    if (attempts === null) {
      // The requeue refuses the row of a run stopped after the claim, and nothing
      // dispatches it again: settle it rather than leave it dispatched to no
      // agent until a sweep finds it.
      // fails-when: a run cancelled between the claim and the put-back leaves the row dispatched
      // breaks-if-wrong: a row that already moved on, or whose run is going, is left as it is
      await this.queue.settleClaimOfStoppedRun(job.id, job.runId);
      return;
    }
    // fails-when: the attempt cap is not checked, so a job no coordinator opens waits for expiry
    if (attempts >= MAX_DISPATCH_ATTEMPTS) {
      const failure = `Job failed after ${attempts} dispatch attempts: ${reason}`;
      logger.error('No coordinator could open the queued job secrets; failing the job', {
        agentId,
        jobId: job.id,
        runId: job.runId,
        attempts,
      });
      await this.queue.markFailed(job.id, failure);
      this.onJobFailedPermanently?.(agentId ?? '', job.id, job.runId, failure);
      return;
    }
    logger.warn(
      'Queued job is sealed with a master key this coordinator does not hold; leaving it for a coordinator that holds the key',
      { agentId, jobId: job.id, runId: job.runId, attempts, error: reason },
    );
    await this.updateQueueDepthMetric();
  }

  /**
   * Settle a pending job with unopenable sealed secrets that a re-drive would
   * otherwise scale for. Scaling is wrong twice: a private image's registry
   * credentials are sealed with the other secrets, so its spawn pulls without
   * them and fails before any agent registers (never claimed, no attempt spent,
   * every re-drive spawns again); and any agent a spawn starts would get the job
   * handed back. So it is claimed by id for no agent and decided as a drain
   * would ({@link releaseUnopenableDispatch}). A claim lost to another
   * coordinator, or refused inside the back-off, leaves the job alone.
   */
  private async settleUnopenablePending(job: QueuedJob, reason: string): Promise<void> {
    if (!(await this.queue.claimUnopenableById(job.id))) return;
    await this.releaseUnopenableDispatch(undefined, job, reason);
  }

  /** Undo a refused job's accounting and fail it; `agentId` undefined = claimed for no agent. */
  private async failRefusedDispatch(
    agentId: string | undefined,
    job: QueuedJob,
    reason: string,
  ): Promise<void> {
    logger.error('Dispatch refused before reaching the agent; failing the job', {
      agentId,
      jobId: job.id,
      runId: job.runId,
      reason,
    });
    this.releaseClaimAccounting(agentId, job.id);
    await this.queue.markFailed(job.id, reason);
    this.onJobFailedPermanently?.(agentId ?? '', job.id, job.runId, reason);
  }

  /** Free the slot and tracking a claim took on its agent; a claim for no agent took none. */
  private releaseClaimAccounting(agentId: string | undefined, jobId: string): void {
    if (agentId === undefined) return;
    if (this.registry.get(agentId)) this.registry.decrementActiveJobs(agentId);
    this.untrackJob(agentId, jobId);
  }

  /**
   * Release the slot and tracking `jobId` holds on `agentId`; false when another
   * path (a refusal, a put-back, a disconnect) already took it.
   */
  private releaseTrackedClaim(agentId: string, jobId: string): boolean {
    if (this.jobToAgent.get(jobId) !== agentId) return false;
    this.releaseClaimAccounting(agentId, jobId);
    return true;
  }

  /**
   * Hand a just-claimed job to `agentId`, whose slot the claim took. A query
   * failing before the send returns the claim ({@link returnUndeliveredClaim})
   * and rethrows, so the agent holds no slot for a job it never received.
   *
   * @returns whether the job was sent.
   */
  private async sendClaimedJob(agentId: string, job: QueuedJob): Promise<boolean> {
    let tracked = false;
    let sent: boolean;
    try {
      await this.queue.markDispatched(job.id, agentId);
      this.trackJobForAgent(agentId, job.id, job.runId);
      tracked = true;
      sent = await this.deliverInRequestContext(agentId, job);
    } catch (err) {
      await this.returnUndeliveredClaim(agentId, job, tracked, err);
      throw err;
    }
    // The job reached the agent: a failure from here on keeps the claim.
    if (sent) {
      await this.armAckDeadline(agentId, job);
      this.metrics.incJobsDispatched('dispatched');
    }
    return sent;
  }

  /**
   * Put back a claimed job a query failure kept from being sent. The slot (and
   * tracking, once taken) is released, and the row returns to pending without
   * spending an attempt, since no agent saw it; the next drain or pending
   * re-drive offers it again. A job a refusal or disconnect already took is left
   * to that path. If the put-back fails too, the row stays dispatched with no ack
   * deadline and the stale-dispatch scan reaps it.
   */
  private async returnUndeliveredClaim(
    agentId: string,
    job: QueuedJob,
    tracked: boolean,
    cause: unknown,
  ): Promise<void> {
    if (tracked) {
      if (!this.releaseTrackedClaim(agentId, job.id)) return;
    } else if (this.registry.get(agentId)) {
      this.registry.decrementActiveJobs(agentId);
    }
    const fields = { agentId, jobId: job.id, runId: job.runId, error: toErrorMessage(cause) };
    try {
      if ((await this.queue.requeue(job.id, { countAttempt: false })) !== null) {
        logger.warn('Returned a claimed job to the queue after its dispatch failed', fields);
      } else if (await this.queue.settleClaimOfStoppedRun(job.id, job.runId)) {
        logger.warn('Settled the claimed job of a stopped run after its dispatch failed', fields);
      } else {
        // Another path (a disconnect, a cancel) already moved the row on.
        logger.warn('Released a claimed job whose dispatch failed; its row had moved on', fields);
      }
    } catch (err) {
      logger.error(
        'Could not return a claimed job to the queue; the stale-dispatch scan reaps it',
        {
          agentId,
          jobId: job.id,
          runId: job.runId,
          error: toErrorMessage(err),
        },
      );
    }
  }

  markJobStarted(jobId: string): void {
    // `job.status: running` doubles as an ack in case the ack itself was lost.
    this.resolvePendingAck(jobId);
    const agentId = this.jobToAgent.get(jobId);
    if (agentId === undefined) return;
    this.startedJobs.add(jobId);
    this.noteJobAccepted(agentId, jobId);
  }

  /**
   * The agent accepted `jobId` (`job.ack`, or `running` standing in for a lost
   * one). An expired busy hold is dropped: the job was dispatched after it ran
   * out, into a free slot, so the job count is not stuck and the next
   * teardown-window rejection must not spend an attempt. A hold still in force
   * is kept — see {@link AgentRegistry.clearExpiredBusyHold}.
   */
  private noteJobAccepted(agentId: string, jobId: string): void {
    // fails-when: a frame for a job not dispatched to this agent drops its hold.
    // breaks-if-wrong: an ack for a job tracked to the agent must still drop an expired hold.
    if (this.jobToAgent.get(jobId) !== agentId) return;
    this.registry.clearExpiredBusyHold(agentId);
  }

  /**
   * Arm the ack deadline for a just-sent dispatch (timer + persisted row).
   * Resolving the timeout and persisting both touch the DB, so a fast job.ack can
   * beat the in-memory entry; `earlyAcks` records it and arming is skipped, since
   * a timer with nothing to resolve it would expire an accepted dispatch.
   */
  private async armAckDeadline(agentId: string, job: QueuedJob): Promise<void> {
    if (this.consumeEarlyAck(job.id, agentId)) {
      // Already acked: clear any stamped deadline, arm no timer.
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
    // Not awaited, so a fast ack cannot race the DB write.
    this.queue.setAckDeadline(job.id, new Date(Date.now() + timeoutMs), agentId).catch((err) => {
      logger.warn('Failed to persist ack deadline', { jobId: job.id, error: toErrorMessage(err) });
    });
  }

  /** Consume a recorded early ack for `jobId` from `agentId`; true if one was pending. */
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

  /** Handle a `job.ack` from an agent. */
  onJobAcked(agentId: string, jobId: string): void {
    this.noteJobAccepted(agentId, jobId);
    const entry = this.pendingAcks.get(jobId);
    if (!entry) {
      // The ack beat its deadline's arming; recorded so armAckDeadline skips it.
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
   * The ack deadline expired: the dispatch is lost. The job is untracked and the
   * agent removed from the registry BEFORE the requeue, so the redispatch cannot
   * land it back on the agent being torn down, and the later WS-close triage
   * finds nothing to double-handle.
   */
  private async handleAckExpiry(agentId: string, jobId: string, runId: string): Promise<void> {
    const entry = this.pendingAcks.get(jobId);
    if (!entry || entry.agentId !== agentId) return; // resolved concurrently
    this.pendingAcks.delete(jobId);
    // Prove the ack never landed and requeue in ONE statement. `pendingAcks` is
    // per-coordinator: the ack may have reached a sibling, which cleared the
    // deadline while this timer ran. An acked job is still `dispatched`, so a
    // plain requeue would flip an executing job to `pending` for a second agent.
    // The guard reads the deadline, so a separate `clearAckDeadline` first would
    // destroy its evidence.
    const attempts = await this.queue.requeueIfAwaitingAck(jobId, agentId || null);
    if (attempts === null) {
      // The ack landed (here or on a sibling), or the row left `dispatched`:
      // the agent is healthy — no teardown, no requeue, no onAckTimeout.
      dispatchOwnershipSkippedTotal.add(1, { action: 'ack_expiry', reason: 'already_resolved' });
      logger.info('Ack expiry: the ack landed or the job moved on, leaving the dispatch alone', {
        agentId,
        jobId,
        runId,
      });
      return;
    }
    logger.warn('Dispatch ack deadline expired, treating dispatch as lost', {
      agentId,
      jobId,
      runId,
    });
    if (this.registry.get(agentId)) this.registry.decrementActiveJobs(agentId);
    this.untrackJob(agentId, jobId);
    // Tear down BEFORE re-dispatching, in this order:
    //  1. onAckTimeout closes the WS; it reads the agent entry, so the agent
    //     must still be registered.
    //  2. unregister removes it from routing synchronously, so the redispatch's
    //     findAvailable cannot re-select it (the async WS close event would leave
    //     it a candidate).
    // The job is already untracked, so the triage leaves it to the requeue.
    this.onAckTimeout?.(agentId, jobId, runId);
    const triage = this.dropUnacknowledgingAgent(agentId);
    await this.finishRequeue(agentId, jobId, 'dispatch ack timeout', attempts);
    await triage;
    await this.updateQueueDepthMetric();
  }

  /**
   * Drop an agent that did not ack a dispatch. Its other in-flight jobs (a
   * multi-slot agent) go through {@link onAgentDisconnect}, which reads the
   * registration before its first await to tell scaler-managed from static, so
   * the triage starts first; the unregister right after removes the agent from
   * routing so a redispatch cannot re-select it while the triage awaits.
   */
  private dropUnacknowledgingAgent(agentId: string): Promise<void> {
    const triage = this.onAgentDisconnect(agentId).then(
      () => undefined,
      (err: unknown) => {
        logger.error('Job triage failed for an agent dropped by an ack timeout', {
          agentId,
          error: toErrorMessage(err),
        });
      },
    );
    this.registry.unregister(agentId);
    return triage;
  }

  /** Handle a `job.reject`: undo the dispatch accounting and requeue for another agent. */
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
    // A busy agent still holds the slot of the job it is tearing down, so it is
    // held out of routing until it shows a free slot and the requeue cannot
    // re-pick it at once. The first busy rejection after free-slot evidence (an
    // empty-slot report, a job on it finishing, a job accepted after the hold
    // ran out) spends no attempt. One from an agent re-picked only because its
    // hold expired, with no evidence since, spends one, so a stuck job count
    // still fails the job at MAX_DISPATCH_ATTEMPTS instead of pending forever.
    const busy = reason === JobRejectReason.enum.busy;
    const hold = busy ? this.registry.markBusyHeld(agentId) : undefined;
    const countAttempt = !busy || hold === BusyHoldOutcome.ReheldAfterExpiry;
    this.registry.decrementActiveJobs(agentId);
    this.untrackJob(agentId, jobId);
    await this.requeueOrFail(agentId, jobId, `agent rejected dispatch (${reason})`, countAttempt);
    await this.updateQueueDepthMetric();
  }

  private untrackJob(agentId: string, jobId: string): void {
    // Reject, disconnect triage and ack expiry all route through here, so this
    // clears their pending ack.
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
   * Requeue a dispatched job, or fail it once its attempt budget is exhausted;
   * the outcome lets disconnect triage surface failed job IDs. `countAttempt:
   * false` spends no budget (a busy rejection).
   */
  private async requeueOrFail(
    agentId: string,
    jobId: string,
    context: string,
    countAttempt: boolean = true,
  ): Promise<'requeued' | 'failed' | 'gone'> {
    const attempts = await this.queue.requeue(jobId, { countAttempt });
    return this.finishRequeue(agentId, jobId, context, attempts);
  }

  /**
   * The post-flip half of {@link requeueOrFail}: fail on an exhausted budget,
   * else re-dispatch. Split out so ack expiry drives it from its guarded
   * requeue's (`requeueIfAwaitingAck`) attempt count without flipping the row twice.
   */
  private async finishRequeue(
    agentId: string,
    jobId: string,
    context: string,
    attempts: number | null,
  ): Promise<'requeued' | 'failed' | 'gone'> {
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
   * Deliver a requeued pending job: an idle matching agent (atomic claim via
   * dispatchBoundJob), else the scaler spawns a fresh agent bound to it.
   */
  private async redispatch(jobId: string): Promise<void> {
    const job = await this.queue.getFullJobById(jobId);
    if (!job || job.status !== DispatchQueueStatus.Pending) return;
    // A job this coordinator just put back for a peer is not re-offered from here
    // inside its back-off; after it, the job is offered again like any other.
    // fails-when: a job put back for a peer is re-claimed here at once, spending the budget
    if (this.queue.isDeferredUnopenable(job.id)) return;
    // fails-when: a requeued job this coordinator cannot open is scaled for without its registry credentials
    // breaks-if-wrong: a requeued job whose secrets opened still goes to an agent or the scaler
    if (job.secretsUnavailable) {
      await this.settleUnopenablePending(job, job.secretsUnavailable);
      return;
    }

    // Label-routed like `dispatch()`: candidates merely match, not necessarily
    // the bound agent, so the same suitability gate drops unsuitable scaler
    // agents and the job falls through to the scaler. The agent started for this
    // job always passes, so it is never filtered out from under it.
    const available = this.filterUnservableAgents(
      this.registry.findAvailable(
        matchLabelsFor(job),
        job.runsOnPatterns ?? [],
        job.excludeLabels ?? [],
        job.excludePatterns ?? [],
      ),
      job,
      job.id,
    );
    if (available.length > 0) {
      const outcome = await this.claimBoundJob(
        selectAgent(available, job.jobConfig).agentId,
        jobId,
      );
      // Claimed means dealt with, sent or not: scaling for a refused or put-back
      // job would start an agent for nothing.
      // fails-when: a claimed job that was refused or put back is also scaled for
      // breaks-if-wrong: a job no idle agent claimed must still reach the scaler below
      if (outcome !== BoundClaimOutcome.NotClaimed) return;
    }
    if (this.onNoMatchingAgent) {
      // Without the spawn context a requeued container job would get a plain
      // agent instead of its own image.
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
   * Safety-net re-drive: deliver each pending job a connected, idle, matching
   * agent could take, through the drain's atomic claim (`dispatchBoundJob` →
   * `dequeueById`).
   *
   * Per-coordinator, NOT leader-gated: each coordinator drains the shared queue
   * onto its OWN agents, and the atomic claim lets at most one agent (on any
   * coordinator) win each job, so concurrent ticks cannot double-dispatch.
   *
   * It closes the requeue gap: a job requeued by `handleAckExpiry` /
   * `onJobRejected` / the leader ack sweep gets one delivery attempt
   * (`redispatch`'s `findAvailable` + `dispatchBoundJob`), and an idle agent whose
   * drain trigger fired before the requeue gets no other. If that attempt misses
   * (the agent momentarily at capacity while a drain holds its eagerly claimed
   * slot, or connected to another coordinator than the one that ran the expiry),
   * the job would sit until it expired; this tick recovers it on the next sweep.
   *
   * Never consults the scaler (that is `retryPendingScaleRequests`) or spawns.
   *
   * Returns the jobs sent; a claimed job not sent (refused, or sealed secrets
   * unopenable here) is not counted. Failures propagate: the per-coord interval
   * wrapper is the single error-log site, like the sibling recovery/ack sweeps
   * on its cadence. The `finally` only releases the single-flight guard.
   */
  async redrivePendingToConnectedAgents(maxJobs: number = DEFAULT_REDRIVE_BATCH): Promise<number> {
    if (this.pendingRedriveInFlight || this.isDraining()) return 0;
    this.pendingRedriveInFlight = true;
    try {
      if ((await this.queue.getDepth()) === 0) return 0;
      const pending = await this.queue.listPending(maxJobs);
      let placed = 0;
      // Claimed but refused or put back: each is logged where it is decided.
      let notSent = 0;
      for (const job of pending) {
        const target = await this.selectConnectedTargetForPending(job);
        if (!target) continue;
        const outcome = await this.claimBoundJob(target, job.id);
        if (outcome === BoundClaimOutcome.Sent) placed++;
        else if (outcome === BoundClaimOutcome.NotSent) notSent++;
      }
      if (placed > 0) {
        logger.info('Re-drove pending jobs onto connected idle agents', {
          placed,
          notSent,
          scanned: pending.length,
        });
      }
      return placed;
    } finally {
      this.pendingRedriveInFlight = false;
    }
  }

  /**
   * Pick a connected agent for a pending job, or null. A pinned host-fanout child
   * runs ONLY on its pinned agent and `dequeueById` ignores the pin, so it never
   * goes to `findAvailable`, which would mis-deliver it to any label match.
   *
   * Reboot-pending gate: the safety-net counterpart of the gate in `dispatch()` /
   * `dispatchPinned` / `drainForAgent`; without it this path re-drives the held
   * post-restart job onto the about-to-reboot host and defeats the hold.
   */
  private async selectConnectedTargetForPending(job: QueuedJob): Promise<string | null> {
    if (job.pinnedAgentId) {
      const agent = this.registry.get(job.pinnedAgentId);
      if (!agent || !agentHasFreeSlot(agent)) return null;
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
    const available = this.filterUnservableAgents(
      await this.filterRebootPending(availableRaw),
      job,
      job.id,
    );
    if (available.length === 0) return null;
    return selectAgent(available, job.jobConfig).agentId;
  }

  /**
   * Handle agent disconnect. Starts per-job recovery timers instead of
   * immediately failing jobs, giving the agent a grace period to reconnect.
   * If no in-flight jobs, performs a clean disconnect.
   *
   * Returns the started jobs a scaler-managed agent's disconnect failed outright;
   * otherwise empty (failures happen asynchronously when recovery timers expire).
   */
  async onAgentDisconnect(agentId: string): Promise<string[]> {
    const entry = this.registry.get(agentId);
    const scalerManaged = entry?.scalerManaged ?? false;
    // The unregisters below run after awaits. A caller that dropped the agent
    // first (token revocation, ack timeout) leaves no entry, so one found then is
    // a reconnect, and removing it would drop a live agent.
    const unregisterIfUnchanged = (): void => {
      if (this.registry.get(agentId) === entry) this.registry.unregister(agentId);
    };
    const jobIds = this.agentJobs.get(agentId);
    if (!jobIds || jobIds.size === 0) {
      // Clean disconnect. The common reboot case: the restart job reported
      // success before the box went down; the reboot-pending flag's drain-gate
      // and clear-on-reconnect are handled elsewhere.
      this.registry.unregister(agentId);
      this.cleanupGraceEntriesForAgent(agentId);
      await this.updateQueueDepthMetric();
      return [];
    }

    // Reboot-pending: this disconnect IS the expected reboot. No recovery→fail
    // timer; in-flight started jobs complete as success (the safety net for a
    // restart-job success report that did not flush before the box went down).
    const rebootPending = (await this.rosterStore?.isRebootPending(agentId, Date.now())) ?? false;
    if (rebootPending && !scalerManaged) {
      await this.completeInFlightForReboot(agentId, [...jobIds]);
      this.cleanupGraceEntriesForAgent(agentId);
      unregisterIfUnchanged();
      await this.updateQueueDepthMetric();
      return [];
    }

    const failedJobIds = scalerManaged
      ? await this.triageScalerManagedDisconnect(agentId, [...jobIds])
      : await this.startRecoveryForDisconnect(agentId, jobIds);

    this.cleanupGraceEntriesForAgent(agentId);
    unregisterIfUnchanged();
    if (failedJobIds.length > 0) {
      try {
        this.disconnectCleanup?.(failedJobIds);
      } catch (err) {
        logger.error('Releasing the waiters of failed jobs threw', {
          agentId,
          error: toErrorMessage(err),
        });
      }
    }
    await this.updateQueueDepthMetric();
    return failedJobIds;
  }

  /**
   * Complete a reboot-pending agent's in-flight started jobs as success (the
   * restart job may already be terminal; `markCompleted` is guarded then). No
   * recovery timer. Untracked so the reconnect reconciles no phantom in-flight set.
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

  private cleanupGraceEntriesForAgent(agentId: string): void {
    for (const [jobId, entry] of this.completedJobs) {
      if (entry.agentId === agentId) this.completedJobs.delete(jobId);
    }
  }

  /** Scaler-managed disconnect: requeue never-started jobs, fail started ones (returned). */
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
   * Static disconnect: per-job recovery timers (the agent may reconnect and
   * reclaim). Always returns []; failures happen when the timers expire.
   */
  private async startRecoveryForDisconnect(
    agentId: string,
    jobIds: Set<string>,
  ): Promise<string[]> {
    const disconnectedAt = Date.now();
    const deadline = new Date(disconnectedAt + this.gracePeriodMs);
    for (const jobId of jobIds) {
      // Recovery now owns the job, superseding any pending ack. Static
      // disconnects keep agentJobs (no untrackJob), so clear it explicitly.
      this.resolvePendingAck(jobId);
      const job = await this.queue.getJobById(jobId);
      const runId = job?.runId ?? '';

      // The stamped deadline + agentId let a replacement coord after a Raft
      // leader switch re-create the timer (`recoverState`) or expire the row in
      // the leader-gated sweep (`sweepExpiredRecoveries`).
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
    // agentJobs is kept for reconciliation on reconnect.
    return [];
  }

  /**
   * An agent finished a job (success or failure). The job moves to the grace
   * window rather than being removed, so late messages (final log chunks) are
   * still accepted.
   */
  onJobComplete(agentId: string, jobId: string): void {
    // Completion bypasses untrackJob, so clear any pending ack here too.
    this.resolvePendingAck(jobId);
    // A tracked job's final status means its slot is being released, so the job
    // count is not stuck: lift any busy hold, even one in force. A following
    // teardown-window rejection re-holds fresh with no attempt spent; left in
    // force, a teardown outlasting the hold would be re-picked on expiry and charged.
    // fails-when: a replayed terminal frame, or one for another agent's job, lifts the hold.
    // breaks-if-wrong: a job finishing on the held agent must lift its hold.
    if (this.agentJobs.get(agentId)?.has(jobId) === true) {
      this.registry.clearBusyHeld(agentId);
    }
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

    // Keeps the stale detector from timing the row out.
    this.queue.markCompleted(jobId).catch((err) => {
      logger.warn('Failed to mark dispatch_queue completed', {
        jobId,
        error: toErrorMessage(err),
      });
    });

    this.completedJobs.set(jobId, {
      agentId,
      expiresAt: Date.now() + Dispatcher.GRACE_WINDOW_MS,
    });

    // Cap: evict the oldest entry.
    if (this.completedJobs.size > Dispatcher.COMPLETED_JOBS_CAP) {
      const iter = this.completedJobs.keys();
      const oldest = iter.next().value;
      if (oldest !== undefined) {
        this.completedJobs.delete(oldest);
      }
    }
  }

  /**
   * True if the job is dispatched to the agent, recovering (disconnected within
   * the grace period), or in the grace window (completed in the last 30 seconds).
   */
  isJobOwnedByAgent(agentId: string, jobId: string): boolean {
    const activeJobs = this.agentJobs.get(agentId);
    if (activeJobs?.has(jobId)) {
      return true;
    }

    const recovering = this.recoveringJobs.get(jobId);
    if (recovering && recovering.agentId === agentId) {
      return true;
    }

    const completed = this.completedJobs.get(jobId);
    if (completed && completed.agentId === agentId && completed.expiresAt > Date.now()) {
      return true;
    }

    return false;
  }

  /** For the cancel-run API; null once the job is untracked (e.g. completed). */
  getAgentIdForJob(jobId: string): string | null {
    return this.jobToAgent.get(jobId) ?? null;
  }

  /** The jobs of `runId` this dispatcher currently tracks to an agent. */
  getTrackedJobIdsForRun(runId: string): string[] {
    const jobIds: string[] = [];
    for (const [jobId, trackedRunId] of this.jobRunIds) {
      if (trackedRunId === runId) jobIds.push(jobId);
    }
    return jobIds;
  }

  /** Start periodic cleanup of expired grace window entries; call at server startup. */
  startGraceCleanup(): void {
    if (this.graceCleanupTimer) return;

    this.graceCleanupTimer = setInterval(() => {
      this.cleanupExpiredGraceEntries();
    }, Dispatcher.GRACE_CLEANUP_INTERVAL_MS);
  }

  /** Call at server shutdown. */
  stopGraceCleanup(): void {
    if (this.graceCleanupTimer) {
      clearInterval(this.graceCleanupTimer);
      this.graceCleanupTimer = null;
    }
  }

  // ── Recovery ─────────────────────────────────────────────────────

  /**
   * Claim a recovering job back for a reconnected agent, cancelling its timer;
   * false if it is not recovering or belongs to a different agent.
   */
  claimRecovery(jobId: string, agentId: string): boolean {
    const entry = this.recoveringJobs.get(jobId);
    if (!entry || entry.agentId !== agentId) return false;

    clearTimeout(entry.timer);
    this.recoveringJobs.delete(jobId);
    return true;
  }

  /**
   * Reconcile a recovering job for a reconnected agent: claim the timer, move
   * the DB row back to dispatched, restore in-memory tracking.
   */
  async reconcileRecovery(jobId: string, agentId: string): Promise<boolean> {
    // Read before claimRecovery deletes the entry.
    const runId = this.recoveringJobs.get(jobId)?.runId;
    const claimed = this.claimRecovery(jobId, agentId);
    if (!claimed) return false;
    await this.queue.markDispatchedIfRecovering(jobId, agentId);
    this.restoreJobForAgent(agentId, jobId, runId);
    return true;
  }

  /** For structured logging. */
  getRecoveryInfo(jobId: string): { disconnectedAt: number; agentId: string } | null {
    const entry = this.recoveringJobs.get(jobId);
    return entry ? { disconnectedAt: entry.disconnectedAt, agentId: entry.agentId } : null;
  }

  /** For reconnection reconciliation. */
  getRecoveringJobsForAgent(agentId: string): string[] {
    const jobIds: string[] = [];
    for (const [jobId, entry] of this.recoveringJobs) {
      if (entry.agentId === agentId) jobIds.push(jobId);
    }
    return jobIds;
  }

  /**
   * Restore a job a reconnected agent claimed from recovery. The agent reports
   * it in-flight, so it had started: marked started for disconnect triage.
   */
  restoreJobForAgent(agentId: string, jobId: string, runId?: string): void {
    // A static disconnect keeps the jobRunIds entry, so it is the fallback.
    this.trackJobForAgent(agentId, jobId, runId ?? this.jobRunIds.get(jobId) ?? '');
    this.startedJobs.add(jobId);
  }

  /**
   * Start a recovery timer for a job found 'dispatched' at startup. Called by
   * orchestrator-core.ts for jobs from a previous orchestrator instance.
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
   * Rebuild `recoveringJobs` from `dispatch_queue` after a coord boot / Raft
   * leader switch. Per `status='recovering'` row:
   *   - future `recovery_deadline`: re-arm a timer for the remaining window.
   *   - past deadline: left to the leader-gated `sweepExpiredRecoveries()`, so
   *     two coords never race to mark the same job failed.
   *   - NULL deadline (pre-migration recovering jobs): the sweep fast-fails it
   *     on its first run.
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
      if (this.recoveringJobs.has(row.id)) continue; // e.g. recoverState called twice
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

    // Re-arm a previous coord's dispatch-ack timers; passed deadlines are left
    // to the leader-gated ack sweep.
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
   * Leader-gated sweep: requeue `dispatched` rows whose ack deadline passed
   * unwatched (the owning coord crashed before its timer fired). The requeue is
   * atomic (WHERE status='dispatched'), so racing coords cannot double-requeue.
   */
  async sweepExpiredAckDeadlines(): Promise<number> {
    const expired = await this.queue.listExpiredAckDeadlines(new Date());
    let requeued = 0;
    for (const row of expired) {
      // Guarded like `handleAckExpiry`: the ack can land between listing and
      // requeue, and only proving "still awaiting an ack" inside the requeue
      // cannot requeue an executing job.
      const attempts = await this.queue.requeueIfAwaitingAck(row.id, row.agentId);
      if (attempts === null) {
        dispatchOwnershipSkippedTotal.add(1, { action: 'ack_sweep', reason: 'already_resolved' });
        logger.info('Ack sweep: the ack landed or the job moved on, leaving the dispatch alone', {
          jobId: row.id,
          runId: row.runId,
          agentId: row.agentId ?? '',
        });
        continue;
      }
      requeued++;
      const entry = this.pendingAcks.get(row.id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pendingAcks.delete(row.id);
      }
      logger.warn('Ack sweep: dispatched job past its ack deadline, requeueing', {
        jobId: row.id,
        runId: row.runId,
        agentId: row.agentId ?? '',
      });
      let triage: Promise<void> | undefined;
      if (row.agentId && this.registry.get(row.agentId)) {
        this.registry.decrementActiveJobs(row.agentId);
        this.untrackJob(row.agentId, row.id);
        // Same order as handleAckExpiry: close the WS (reads the agent entry),
        // then remove from routing before re-dispatching.
        this.onAckTimeout?.(row.agentId, row.id, row.runId);
        triage = this.dropUnacknowledgingAgent(row.agentId);
      }
      await this.finishRequeue(row.agentId ?? '', row.id, 'dispatch ack deadline sweep', attempts);
      await triage;
    }
    if (requeued > 0) {
      logger.info('dispatcher: leader sweep requeued un-acked dispatches', { expired: requeued });
    }
    return requeued;
  }

  /**
   * Leader-gated sweep: fail `recovering` rows with `recovery_deadline < now`
   * and fire `onJobFailedPermanently`, so jobs whose owning coord crashed
   * mid-recovery still reach a terminal state. Runs on the Raft leader at a
   * fixed interval; idempotent on followers (WHERE clause), skipped there to
   * avoid redundant DB updates.
   */
  async sweepExpiredRecoveries(): Promise<number> {
    const expired = await this.queue.sweepExpiredRecoveries(new Date());
    for (const row of expired) {
      // This coord also owned the row: cancel its timer, which would otherwise
      // fire on a terminal row (benign, but tidy).
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

  /** Called during graceful shutdown. */
  stopRecoveryTimers(): void {
    for (const [, entry] of this.recoveringJobs) {
      clearTimeout(entry.timer);
    }
    this.recoveringJobs.clear();
    // This coord's dispatch-ack timers too, so the process can exit cleanly.
    for (const [, entry] of this.pendingAcks) {
      clearTimeout(entry.timer);
    }
    this.pendingAcks.clear();
    this.earlyAcks.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────

  /**
   * Recovery timer expiry for one job, shared by onAgentDisconnect and
   * startRecoveryTimer; callers `.catch()` it to avoid unhandled rejections in
   * setTimeout.
   */
  private async handleRecoveryExpiry(agentId: string, jobId: string): Promise<void> {
    const entry = this.recoveringJobs.get(jobId);
    const entryRunId = entry?.runId ?? '';
    this.recoveringJobs.delete(jobId);
    this.jobToAgent.delete(jobId);
    this.jobRunIds.delete(jobId);
    this.startedJobs.delete(jobId);
    const agentJobIds = this.agentJobs.get(agentId);
    if (agentJobIds) {
      agentJobIds.delete(jobId);
      if (agentJobIds.size === 0) this.agentJobs.delete(agentId);
    }
    // Permanently fail, optimistically: only if still recovering.
    const reason =
      'Job failed: agent disconnected and did not reconnect within the recovery window';
    logger.warn('Job recovery timed out', { agentId, jobId, runId: entryRunId });
    const failed = await this.queue.markFailedIfRecovering(jobId, reason);
    if (!failed) {
      // The row left `recovering` first (the agent reclaimed the job, or another
      // coordinator resolved it). The DB guard protects `dispatch_queue`, but
      // `onJobFailedPermanently` fails `execution_jobs` and cancels steps
      // unconditionally, so firing it would fail a running job. Same shape as
      // `requeueOrFail` returning 'gone' and `sweepExpiredRecoveries` firing only
      // for rows its own sweep flipped.
      dispatchOwnershipSkippedTotal.add(1, {
        action: 'recovery_expiry',
        reason: 'already_resolved',
      });
      logger.info('Recovery expiry: row no longer recovering, skipping failure', {
        jobId,
        agentId,
        runId: entryRunId,
      });
      return;
    }
    // Report the permanent failure (with runId) so the receiver marks the
    // execution-tracker job failed.
    this.onJobFailedPermanently?.(agentId, jobId, entryRunId, reason);
  }

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
   * The runId of `jobId` from dispatcher tracking, if `agentId` currently owns
   * it; else `undefined` (also when the runId is no longer tracked). The
   * provenance token relay binds a minted token to a job the agent actually
   * owns — the agent never asserts a runId.
   */
  resolveOwnedJob(agentId: string, jobId: string): { runId: string } | undefined {
    if (!this.agentJobs.get(agentId)?.has(jobId)) return undefined;
    const runId = this.jobRunIds.get(jobId);
    return runId ? { runId } : undefined;
  }

  /**
   * Mark a queued job failed: the coordinator cleans up its local fallback
   * entry once a peer accepts the rerouted job.
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
