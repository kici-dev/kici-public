/**
 * Run coordinator for multi-orchestrator job routing.
 *
 * The receiving orchestrator becomes the run coordinator: it claims jobs
 * it can dispatch locally and reroutes others to peers based on agent
 * inventory.
 * - One orchestrator coordinates per webhook run.
 * - The coordinator handles ALL check run reporting.
 * - Peers report step-by-step progress back to the coordinator.
 * - Cancel is graceful: finish the current step, cancel the remaining ones.
 */

import { randomUUID } from 'node:crypto';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import type {
  JobReroute,
  JobProgress,
  JobProgressAck,
  PeerScalerEvent,
  PeerJobCancel,
  PeerToPeerMessage,
  RerouteSpawnRetry,
  ResourceRequest,
  LabelMatcher,
} from '@kici-dev/engine';
import { TERMINAL_JOB_STATES, ExecutionJobStatus, ScalerEventType } from '@kici-dev/engine';
import type { PeerRegistry, PeerInfo } from './peer-registry.js';
import { WorkerEviction, type EvictionHooks } from './worker-eviction.js';
import type { PeerClient } from './peer-client.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import type { QueuedJobInput } from '../queue/job-queue.js';

const logger = createLogger({ prefix: 'coordinator' });

/** Default ACK timeout for rerouted jobs (15s). */
const DEFAULT_ACK_TIMEOUT_MS = 15_000;

/** Maximum allowed hops for rerouted jobs to prevent routing loops. */
const DEFAULT_MAX_HOPS = 3;

/**
 * Default reroute spawn window (90s): how long after a peer ACKs a reroute the
 * coordinator treats "accepted but no progress" as a spawn failure and
 * re-dispatches. Used when no reader is wired; production reads
 * `org_settings.reroute_spawn_window_ms` / `config.rerouteSpawnWindowMs`.
 */
const DEFAULT_REROUTE_SPAWN_WINDOW_MS = 90_000;

/**
 * Default spawn-retry budget a worker applies to a rerouted job, used when no
 * reader is wired; production reads
 * `org_settings.reroute_spawn_max_attempts` / `reroute_spawn_retry_backoff_ms`.
 */
const DEFAULT_REROUTE_SPAWN_RETRY: RerouteSpawnRetry = { maxAttempts: 3, backoffMs: 5_000 };

// --- Types ---

export interface RunContext {
  runId: string;
  deliveryId: string;
  routingKey: string;
  event: string;
  action: string | null;
  provider: string;
  payload: Record<string, unknown>;
  repoIdentifier: string;
  sha: string;
  ref: string;
  workflowName: string;
  installationId?: number;
  requestId?: string;
  traceId?: string;
  /** Pre-resolved clone token for workers without provider credentials. */
  cloneToken?: string;
  /** Pre-resolved clone token for the workflow repository of an organization-wide job. */
  workflowCloneToken?: string;
}

export interface JobToRoute {
  jobName: string;
  runsOnLabels: string[][];
  /** Regex matchers the agent's labels must satisfy (JS post-filter). */
  runsOnPatterns?: LabelMatcher[];
  /** Regex matchers that disqualify an agent (JS post-filter). */
  excludePatterns?: LabelMatcher[];
  jobConfig: Record<string, unknown>;
  repoUrl: string;
  ref: string;
  sha: string;
  sourceTarUrl?: string;
  sourceTarDigest?: string;
  depsUrl?: string;
  depsHash?: string;
  /** Labels that the dispatched agent must NOT have. */
  excludeLabels?: string[];
  /**
   * Per-job resource request and limit (K8s-style), forwarded typed to
   * `Dispatcher.dispatch()` for the scaler's cap accounting: the dispatcher does
   * not parse the `jobConfig.resources` JSON blob.
   */
  resources?: ResourceRequest;
}

export interface RouteResult {
  localJobs: Array<{ jobName: string; jobId: string }>;
  /** The pre-allocated jobId, so the caller's execution rows match the worker's reports. */
  reroutedJobs: Array<{ jobName: string; peerId: string; jobId: string }>;
  failedJobs: Array<{ jobName: string; reason: string }>;
}

export interface RunCoordinatorDeps {
  instanceId: string;
  peerRegistry: PeerRegistry;
  dispatcher: Dispatcher;
  executionTracker?: ExecutionTracker;
  checkRunReporter?: CheckRunReporter;
  getPeerClient: (instanceId: string) => PeerClient | undefined;
  /** Fallback: send job.reroute via server-side (incoming) peer connection and wait for ACK. */
  sendAndWaitAckViaHandler?: (
    targetInstanceId: string,
    msg: JobReroute,
    timeoutMs: number,
  ) => Promise<boolean>;
  /** Fallback: send a message via server-side (incoming) peer connection (fire-and-forget). */
  sendToPeerViaHandler?: (targetInstanceId: string, msg: PeerToPeerMessage) => boolean;
  /** Close a peer's incoming socket by instanceId (used by worker eviction). */
  closePeerViaHandler?: (targetInstanceId: string, code: number, reason: string) => void;
  ackTimeoutMs?: number;
  /** Stale peer timeout in ms. Default: 60000 (60s). */
  staleTimeoutMs?: number;
  /**
   * Post-ACK re-dispatch backstop window (ms): the job's org override from
   * `org_settings.reroute_spawn_window_ms`, else the cluster default. Absent:
   * {@link DEFAULT_REROUTE_SPAWN_WINDOW_MS}.
   */
  getRerouteSpawnWindowMs?: (job: JobToRoute) => Promise<number>;
  /** `sendAndWaitAck` deadline (ms). Absent: `ackTimeoutMs` / {@link DEFAULT_ACK_TIMEOUT_MS}. */
  getRerouteAckTimeoutMs?: (job: JobToRoute) => Promise<number>;
  /** Absent: {@link DEFAULT_MAX_HOPS}. */
  getRerouteMaxHops?: (job: JobToRoute) => Promise<number>;
  /**
   * Spawn-retry budget sent to the receiving peer on `job.reroute` and enforced
   * here on its relayed spawn failures: the job's org overrides from
   * `org_settings.reroute_spawn_max_attempts` / `reroute_spawn_retry_backoff_ms`,
   * else the cluster defaults. Absent: {@link DEFAULT_REROUTE_SPAWN_RETRY}.
   */
  getRerouteSpawnRetry?: (job: JobToRoute) => Promise<RerouteSpawnRetry>;
}

/**
 * A job rerouted to a peer, with everything the post-ACK backstop needs to
 * re-route it (another peer or local) when the peer accepts but never reports
 * progress (async spawn failure, peer crash).
 */
interface RerouteTracking {
  peerId: string;
  jobName: string;
  runContext: RunContext;
  job: JobToRoute;
  labelSets: string[][];
  /** Connections already tried (this instance + every failed peer), for loop prevention. */
  triedConnections: string[];
  /**
   * Set once the shared `execution_jobs` row showed the peer had started the
   * job. Latched, so a later database fault cannot make the backstop re-dispatch
   * a job already known to be running.
   */
  peerStarted: boolean;
  /**
   * Armed spawn-window timer; cleared on first progress or terminal cleanup.
   * Re-armed as a reap poll once `peerStarted` latches, because a peer
   * COORDINATOR relays nothing that would otherwise release the entry.
   */
  windowTimer: NodeJS.Timeout | undefined;
  /** The spawn-retry budget sent to the peer on the reroute. */
  spawnRetry: RerouteSpawnRetry;
  /** `final: false` spawn failures the tracked peer has relayed. */
  spawnFailures: number;
}

/** NAK backoff base delay (1s). */
const NAK_BACKOFF_BASE_MS = 1_000;
/** NAK backoff maximum delay (60s). */
const NAK_BACKOFF_MAX_MS = 60_000;

// --- RunCoordinator ---

export class RunCoordinator {
  private readonly instanceId: string;
  private readonly peerRegistry: PeerRegistry;
  private readonly dispatcher: Dispatcher;
  private readonly executionTracker?: ExecutionTracker;
  private readonly checkRunReporter?: CheckRunReporter;
  private readonly getPeerClient: (instanceId: string) => PeerClient | undefined;
  private readonly sendAndWaitAckViaHandler?: (
    targetInstanceId: string,
    msg: JobReroute,
    timeoutMs: number,
  ) => Promise<boolean>;
  private readonly sendToPeerViaHandler?: (
    targetInstanceId: string,
    msg: PeerToPeerMessage,
  ) => boolean;
  private readonly ackTimeoutMs: number;
  private readonly getRerouteSpawnWindowMs: (job: JobToRoute) => Promise<number>;
  private readonly getRerouteAckTimeoutMs: (job: JobToRoute) => Promise<number>;
  private readonly getRerouteMaxHops: (job: JobToRoute) => Promise<number>;
  private readonly getRerouteSpawnRetry: (job: JobToRoute) => Promise<RerouteSpawnRetry>;

  /** runId → jobId → reroute target: cancel propagation, progress, and the spawn backstop. */
  private readonly reroutedJobs = new Map<string, Map<string, RerouteTracking>>();

  /** Consecutive NAKs per peer; a repeatedly NAKing peer is skipped under exponential backoff. */
  private readonly nakTracker = new Map<string, { count: number; backoffUntil: number }>();

  private staleEvictionTimer: ReturnType<typeof setInterval> | null = null;

  /** Plan-ceiling worker eviction (drain-then-disconnect). */
  private readonly workerEviction: WorkerEviction;

  /** Per-peer "no in-flight rerouted jobs" callbacks, fired by worker drain. */
  private readonly evictionIdleCallbacks = new Map<string, () => void>();

  private readonly closePeerViaHandler?: (
    targetInstanceId: string,
    code: number,
    reason: string,
  ) => void;

  constructor(deps: RunCoordinatorDeps) {
    this.instanceId = deps.instanceId;
    this.peerRegistry = deps.peerRegistry;
    this.closePeerViaHandler = deps.closePeerViaHandler;
    this.dispatcher = deps.dispatcher;
    this.executionTracker = deps.executionTracker;
    this.checkRunReporter = deps.checkRunReporter;
    this.getPeerClient = deps.getPeerClient;
    this.sendAndWaitAckViaHandler = deps.sendAndWaitAckViaHandler;
    this.sendToPeerViaHandler = deps.sendToPeerViaHandler;
    this.ackTimeoutMs = deps.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.getRerouteSpawnWindowMs =
      deps.getRerouteSpawnWindowMs ?? (async () => DEFAULT_REROUTE_SPAWN_WINDOW_MS);
    this.getRerouteAckTimeoutMs = deps.getRerouteAckTimeoutMs ?? (async () => this.ackTimeoutMs);
    this.getRerouteMaxHops = deps.getRerouteMaxHops ?? (async () => DEFAULT_MAX_HOPS);
    this.getRerouteSpawnRetry =
      deps.getRerouteSpawnRetry ?? (async () => DEFAULT_REROUTE_SPAWN_RETRY);

    const evictionHooks: EvictionHooks = {
      // A permanent NAK backoff: no new dispatch reaches a draining worker.
      markIneligible: (id) =>
        this.nakTracker.set(id, {
          count: Number.MAX_SAFE_INTEGER,
          backoffUntil: Number.MAX_SAFE_INTEGER,
        }),
      // Called on a cancelled drain and after a drained peer disconnects, so a
      // re-admitted instance is not silently starved.
      clearIneligible: (id) => {
        this.nakTracker.delete(id);
        this.evictionIdleCallbacks.delete(id);
      },
      runningJobCount: (id) => this.runningJobCountForPeer(id),
      onPeerIdle: (id, cb) => this.evictionIdleCallbacks.set(id, cb),
      closePeer: (id, code, reason) => {
        this.peerRegistry.markDisconnected(id);
        this.closePeerViaHandler?.(id, code, reason);
      },
    };
    this.workerEviction = new WorkerEviction(this.peerRegistry, evictionHooks, logger);
  }

  /** In-flight rerouted jobs currently attributed to a peer. */
  private runningJobCountForPeer(instanceId: string): number {
    let count = 0;
    for (const runJobs of this.reroutedJobs.values()) {
      for (const tracking of runJobs.values()) {
        if (tracking.peerId === instanceId) count++;
      }
    }
    return count;
  }

  /** Fire a registered drain idle-callback once the peer has no in-flight jobs. */
  private fireIdleIfDrained(instanceId: string): void {
    const cb = this.evictionIdleCallbacks.get(instanceId);
    if (cb && this.runningJobCountForPeer(instanceId) === 0) {
      this.evictionIdleCallbacks.delete(instanceId);
      cb();
    }
  }

  /**
   * Reconcile this coordinator's workers against the pushed ceiling. Invoked on
   * every `plan.headroom` frame: when `evictExcess` is set, the newest workers
   * past `ceiling` are drained; otherwise any in-flight drain is cancelled and
   * the worker restored, so a raised ceiling rescues it.
   */
  reconcileWorkerEviction(ceiling: number, evictExcess: boolean): void {
    this.workerEviction.reconcile(ceiling, evictExcess);
  }

  /**
   * Claim the jobs local agents can handle and reroute the rest, concurrently,
   * to peers with matching capacity.
   */
  async routeJobs(runContext: RunContext, jobs: JobToRoute[]): Promise<RouteResult> {
    const result: RouteResult = {
      localJobs: [],
      reroutedJobs: [],
      failedJobs: [],
    };

    const toReroute: Array<{
      job: JobToRoute;
      labelSets: string[][];
      localFallbackJobId?: string;
    }> = [];

    // Phase 1: Try dispatching each job locally via the Dispatcher.
    // It consults the scaler (onNoMatchingAgent) when no agent is connected, so a
    // job matching a local scaler backend stays local. Only a rejection (no agent
    // AND no scaler backend) reroutes to peers.
    for (const job of jobs) {
      const flatLabels = job.runsOnLabels.length > 0 ? job.runsOnLabels[0] : [];

      const jobInput: QueuedJobInput = {
        runId: runContext.runId,
        workflowName: runContext.workflowName,
        jobName: job.jobName,
        runsOnLabels: flatLabels,
        runsOnPatterns: job.runsOnPatterns,
        excludePatterns: job.excludePatterns,
        excludeLabels: job.excludeLabels,
        jobConfig: job.jobConfig,
        repoUrl: job.repoUrl,
        ref: job.ref,
        sha: job.sha,
        deliveryId: runContext.deliveryId,
        provider: runContext.provider,
        providerContext: runContext.installationId
          ? { installationId: runContext.installationId }
          : {},
        routingKey: runContext.routingKey,
        sourceTarUrl: job.sourceTarUrl,
        sourceTarDigest: job.sourceTarDigest,
        depsUrl: job.depsUrl,
        depsHash: job.depsHash,
        requestId: runContext.requestId,
        ...(job.resources && { resources: job.resources }),
      };

      const dispatchResult = await this.dispatcher.dispatch(jobInput);
      if (dispatchResult.status === 'rejected') {
        // Local dispatch rejected (queue full) -- try peers
        toReroute.push({ job, labelSets: job.runsOnLabels });
      } else if (dispatchResult.status === 'queued-no-backend') {
        // Queued locally as a fallback with no backend: a peer that accepts
        // cancels the local entry.
        toReroute.push({
          job,
          labelSets: job.runsOnLabels,
          localFallbackJobId: dispatchResult.jobId,
        });
      } else {
        result.localJobs.push({ jobName: job.jobName, jobId: dispatchResult.jobId });
      }
    }

    // Phase 2: Reroute jobs to peers (parallel fan-out for different peers)
    if (toReroute.length > 0) {
      const reroutePromises = toReroute.map((entry) =>
        this.rerouteJob(runContext, entry.job, entry.labelSets).then(async (rerouteResult) => {
          if (rerouteResult.success) {
            result.reroutedJobs.push({
              jobName: entry.job.jobName,
              peerId: rerouteResult.peerId!,
              jobId: rerouteResult.jobId!,
            });
            if (entry.localFallbackJobId) {
              await this.dispatcher.cancelQueuedJob(entry.localFallbackJobId, 'rerouted to peer');
            }
          } else {
            if (entry.localFallbackJobId) {
              // Peer reroute failed but local fallback is still queued — treat as local
              result.localJobs.push({
                jobName: entry.job.jobName,
                jobId: entry.localFallbackJobId,
              });
            } else {
              result.failedJobs.push({
                jobName: entry.job.jobName,
                reason: rerouteResult.reason!,
              });
            }
          }
        }),
      );

      await Promise.all(reroutePromises);
    }

    logger.info('Jobs routed', {
      runId: runContext.runId,
      local: result.localJobs.length,
      rerouted: result.reroutedJobs.length,
      failed: result.failedJobs.length,
    });

    return result;
  }

  /** Accept a peer's job reroute (this instance is the worker) by dispatching it locally. */
  async handleIncomingReroute(msg: JobReroute): Promise<{ accepted: boolean; reason?: string }> {
    if (msg.triedConnections.includes(this.instanceId)) {
      return { accepted: false, reason: 'Loop detected' };
    }

    if (msg.triedConnections.length >= msg.maxHops) {
      return { accepted: false, reason: 'Max hops exceeded' };
    }

    const flatLabels = msg.runsOnLabels.length > 0 ? msg.runsOnLabels[0] : [];

    // Through the Dispatcher, not agentRegistry.findAvailable: the Dispatcher
    // spawns on-demand agents, so an orchestrator with scaler capacity but no
    // registered agent still accepts.
    const jobInput: QueuedJobInput = {
      // The sender-allocated jobId: progress must reference the id in the sender's DB.
      jobId: msg.jobId,
      runId: msg.runId,
      workflowName: msg.workflowName,
      jobName: msg.jobName,
      runsOnLabels: flatLabels,
      excludeLabels: msg.excludeLabels,
      // Carry the selectors so matching equals the single-orchestrator path: a
      // pure-regex job must not match an agent lacking the pattern just because
      // it carries no exact labels.
      runsOnPatterns: msg.runsOnPatterns,
      excludePatterns: msg.excludePatterns,
      jobConfig: msg.jobConfig ?? msg.payload,
      repoUrl: msg.repoUrl ?? '',
      ref: msg.ref ?? '',
      sha: msg.sha ?? '',
      deliveryId: msg.deliveryId,
      provider: msg.provider ?? '',
      providerContext: msg.providerContext ?? {},
      routingKey: msg.routingKey,
      requestId: msg.requestId,
      sourceTarUrl: msg.sourceTarUrl,
      sourceTarDigest: msg.sourceTarDigest,
      depsUrl: msg.depsUrl,
      depsHash: msg.depsHash,
    };

    const repoUrl = msg.repoUrl ?? '';
    const repoIdentifier =
      repoUrl
        .replace(/\.git$/, '')
        .replace(/^https?:\/\/[^/]+\//, '')
        .replace(/^[^/]+@[^:]+:/, '') || '';
    const providerContext = msg.providerContext ?? {};
    const installationId =
      typeof providerContext.installationId === 'number'
        ? (providerContext.installationId as number)
        : undefined;

    // Create check runs BEFORE dispatching, and awaited (setPendingAwait, not
    // setPending): the check run IDs MUST be in memory before the job completes,
    // or the reporter logs "Check run ID not found" and never updates the run.
    if (this.checkRunReporter && repoIdentifier && msg.sha) {
      const [owner, repo] = repoIdentifier.split('/');
      // The repository that DEFINES an organization-wide workflow. No such job
      // reaches here: a global candidate goes straight through
      // `dispatcher.dispatch`, never `routeJobs`, the only `job.reroute` sender.
      // Read it anyway: an unqualified create would post a second check run
      // under the acted-on repository's name. `CheckRunReporter.workflowLabel`
      // drops the qualifier when both repositories are the same, so this is
      // inert for every job that does reach here.
      const rawJobConfig = jobInput.jobConfig as Record<string, unknown> | undefined;
      const workflowRepoIdentifier =
        typeof rawJobConfig?.workflowRepoIdentifier === 'string'
          ? rawJobConfig.workflowRepoIdentifier
          : undefined;
      if (owner && repo) {
        try {
          await this.checkRunReporter.setPendingAwait({
            provider: msg.provider ?? '',
            owner,
            repo,
            sha: msg.sha,
            workflowName: msg.workflowName,
            ...(workflowRepoIdentifier && { workflowRepoIdentifier }),
            jobNames: [msg.jobName],
            installationId,
            requestId: msg.requestId,
            runId: msg.runId,
          });
        } catch (err) {
          // Best-effort: the job still runs, without check run updates.
          logger.warn('Failed to create check runs for rerouted job', {
            runId: msg.runId,
            error: toErrorMessage(err),
          });
        }
      }
    }

    const result = await this.dispatcher.dispatch(jobInput);
    if (result.status === 'rejected') {
      return { accepted: false, reason: 'Dispatch rejected: ' + (result as any).reason };
    }
    if (result.status === 'duplicate') {
      // A dispatch_queue row for this jobId exists (a concurrent reroute from the
      // sibling coordinator, or a duplicate delivery): accept as an idempotent
      // no-op, without re-registering tracking or double-dispatching.
      return { accepted: true };
    }

    // Register the run locally: the sender cannot observe the job status on this
    // instance, so only this tracker can update the check run.
    if (this.executionTracker && result.jobId) {
      try {
        // reroute projection — owning orchestrator holds the authoritative deadline
        await this.executionTracker.onExecutionStarted(
          msg.runId,
          msg.workflowName,
          msg.provider ?? '',
          repoIdentifier,
          msg.ref ?? '',
          msg.sha ?? '',
          msg.deliveryId,
          providerContext,
          null, // triggerDecision
          [{ jobId: result.jobId, jobName: msg.jobName }],
          msg.routingKey,
        );
      } catch (err) {
        // Best-effort: ExecutionTracker sets its in-memory state before the DB
        // insert, so a failed insert (e.g. duplicate key from the coordinator)
        // still allows check run updates via onExecutionComplete.
        logger.warn('Failed to register rerouted execution for tracking', {
          runId: msg.runId,
          error: toErrorMessage(err),
        });
      }
    }

    return { accepted: true };
  }

  /**
   * Apply a worker (or coord) peer's job/step progress. `msg.kind` picks the
   * tracker call: 'job' feeds `onJobStatus` (run-level state transitions and
   * rerouted-job cleanup); 'step' feeds `onStepStatus` (only `execution_steps`
   * rows). A job-level event sent to `onStepStatus` leaves the run in `running`
   * forever.
   */
  onPeerJobProgress(
    msg: JobProgress,
    fromPeerId: string,
    reply?: (m: JobProgressAck) => void,
  ): void {
    const tracked = this.reroutedJobs.get(msg.runId)?.get(msg.jobId);
    const isJobTerminal = msg.kind === 'job' && TERMINAL_JOB_STATES.has(msg.state);
    // A terminal from a peer other than the tracked one is a stray from a
    // superseded peer after a reroute moved the job. Skipping its apply + cleanup
    // keeps it from (1) terminalizing the run while the replacement still runs and
    // (2) stripping the replacement's spawn-window backstop. It is still ACKed so
    // the superseded peer prunes its durable outbox: a re-send after the
    // replacement's own cleanup would find no tracked entry and fall through to
    // the unconditional apply.
    const isSupersededTerminal =
      isJobTerminal && tracked !== undefined && tracked.peerId !== fromPeerId;

    // First progress from the tracked reroute TARGET means its spawn succeeded:
    // disarm the backstop. Gate on the source peer: a stray progress from a
    // superseded/cancelled peer must NOT strip the backstop off a job still spawning.
    if (tracked?.windowTimer && tracked.peerId === fromPeerId) {
      clearTimeout(tracked.windowTimer);
      tracked.windowTimer = undefined;
    }

    if (isSupersededTerminal) {
      logger.warn('Ignoring stray terminal job update from superseded peer', {
        runId: msg.runId,
        jobId: msg.jobId,
        state: msg.state,
        fromPeerId,
        trackedPeerId: tracked?.peerId,
      });
      reply?.({
        type: 'job.progress.ack',
        runId: msg.runId,
        jobId: msg.jobId,
        state: msg.state,
      });
    } else if (this.executionTracker) {
      const trackerCall =
        msg.kind === 'job'
          ? this.executionTracker.onJobStatus(
              msg.runId,
              msg.jobId,
              msg.state,
              msg.timestamp,
              undefined,
              msg.data,
            )
          : this.executionTracker.onStepStatus(
              msg.runId,
              msg.jobId,
              msg.stepIndex,
              msg.stepName,
              msg.state,
              msg.timestamp,
              msg.data,
            );

      trackerCall
        .then(async () => {
          // Re-assert the durable `rerouted_to_peer` marker: the worker's FIRST
          // status creates the execution_jobs row, seconds after the reroute ACK,
          // so the reroute-time UPDATE in trackReroutedJob matches zero rows.
          // Without the marker the run-recovery sweepers force-fail the job the
          // moment its heartbeat goes stale. Idempotent; skipped on terminal
          // updates (moot once done, and reroutedJobs is cleared below).
          const trackedNow = this.reroutedJobs.get(msg.runId)?.get(msg.jobId);
          if (trackedNow && this.executionTracker && !TERMINAL_JOB_STATES.has(msg.state)) {
            await this.executionTracker.markJobReroutedToPeer(
              msg.runId,
              msg.jobId,
              trackedNow.peerId,
            );
          }

          // ACK a terminal only after the apply resolves; the worker then prunes
          // its durable outbox. An already-applied replay still resolves and acks,
          // so the worker prunes after a coordinator restart.
          if (msg.kind === 'job' && TERMINAL_JOB_STATES.has(msg.state)) {
            reply?.({
              type: 'job.progress.ack',
              runId: msg.runId,
              jobId: msg.jobId,
              state: msg.state,
            });
          }
        })
        .catch((err) => {
          logger.error('Failed to track peer job progress', {
            error: toErrorMessage(err),
            runId: msg.runId,
            jobId: msg.jobId,
            kind: msg.kind,
          });
        });
    }

    // Release tracking on a job terminal, so cancel propagation sees the right
    // residual set. Not for a superseded-peer terminal: the replacement still
    // owns the job, its entry and its spawn-window timer.
    if (isJobTerminal && !isSupersededTerminal) {
      const runJobs = this.reroutedJobs.get(msg.runId);
      if (runJobs) {
        const entry = runJobs.get(msg.jobId);
        if (entry?.windowTimer) clearTimeout(entry.windowTimer);
        const drainedPeerId = entry?.peerId;
        runJobs.delete(msg.jobId);
        if (runJobs.size === 0) {
          this.reroutedJobs.delete(msg.runId);
        }
        // A draining worker's last job ended: disconnect now, not at the drain timeout.
        if (drainedPeerId) this.fireIdleIfDrained(drainedPeerId);
      }
    }

    logger.debug('Peer job progress', {
      runId: msg.runId,
      jobId: msg.jobId,
      kind: msg.kind,
      stepName: msg.stepName,
      state: msg.state,
    });
  }

  /**
   * Persist a scaler event a worker peer relayed (workers have no database):
   * provisioning log line + dispatch-queue last-error column, as for a local one.
   *
   * Layer B: a `scaler.failed` for a tracked rerouted job whose spawn window is
   * still armed is an agent spawn failing after the worker accepted the reroute.
   * The worker retries within the spawn-retry budget sent on `job.reroute`, and
   * the relay carries its verdict:
   *
   * - `final: true` — the worker gave the job back. Re-dispatch immediately (the
   *   same routine the spawn-window timer runs). Idempotent with the Layer A
   *   timer: whichever fires first removes the tracking entry.
   * - `final: false` — the worker is retrying. Re-arm the window for one more
   *   attempt plus the backoff; treat the `maxAttempts`-th such relay as final.
   * - no verdict — a repeated report of one failed spawn. The window armed at
   *   the reroute keeps running unchanged.
   *
   * Two guards make the re-dispatch safe. First, source provenance: the failure
   * must come from `fromPeerId === tracked.peerId` (the authenticated connection
   * identity), so a late `scaler.failed` relayed for the same jobId by a
   * superseded peer after an earlier re-dispatch is ignored rather than bouncing
   * the healthy replacement. Second, the armed-window check: once the first
   * progress disarms the timer (`windowTimer` cleared to undefined), the job is
   * executing and a stale failure must NOT cancel the running job. Persistence
   * (`emitScalerEvent`) stays unconditional — it is keyed on `(runId, jobId)` and
   * correct regardless of which peer relayed the event.
   */
  onPeerScalerEvent(msg: PeerScalerEvent, fromPeerId: string): void {
    this.executionTracker?.emitScalerEvent(msg.runId, msg.jobId, {
      agentId: msg.agentId,
      eventType: msg.eventType,
      detail: msg.detail,
      timestampMs: msg.timestampMs,
    });

    // Layer B — gated on source provenance AND an armed window (see above).
    const tracked = this.reroutedJobs.get(msg.runId)?.get(msg.jobId);
    if (
      msg.eventType !== ScalerEventType.enum['scaler.failed'] ||
      tracked?.windowTimer === undefined ||
      tracked.peerId !== fromPeerId
    ) {
      return;
    }
    this.onRelayedSpawnFailure(msg, tracked);
  }

  /**
   * A worker's verdict on a failed spawn for a job it holds. `final: true` means it
   * gave the job back, so re-dispatch now. `final: false` means it is retrying, so
   * restart the window for one more attempt plus the backoff this coordinator told it
   * to wait. No verdict means a repeated report of one failed spawn, or a failure
   * the worker holds no retry budget for, so leave the window as it is. The count
   * caps a worker that never says `final`.
   */
  private onRelayedSpawnFailure(msg: PeerScalerEvent, tracked: RerouteTracking): void {
    const { runId, jobId } = msg;
    if (msg.final === undefined) {
      logger.info(
        'Worker relayed scaler.failed without a retry verdict — waiting out the spawn window',
        { runId, jobId, detail: msg.detail },
      );
      return;
    }
    if (!msg.final) {
      tracked.spawnFailures += 1;
      if (tracked.spawnFailures < tracked.spawnRetry.maxAttempts) {
        logger.info('Worker retrying spawn for a rerouted job — spawn window re-armed', {
          runId,
          jobId,
          attempt: tracked.spawnFailures,
          maxAttempts: tracked.spawnRetry.maxAttempts,
          detail: msg.detail,
        });
        this.rearmAfterSpawnRetry(runId, jobId, tracked).catch((err: unknown) => {
          logger.error('Reroute spawn-window re-arm failed', {
            runId,
            jobId,
            error: toErrorMessage(err),
          });
        });
        return;
      }
    }
    logger.warn('Worker exhausted spawn retries for a rerouted job — re-dispatching', {
      runId,
      jobId,
      detail: msg.detail,
    });
    this.handleRerouteSpawnTimeout(runId, jobId).catch((err: unknown) => {
      logger.error('Reroute exhausted-retries handler failed', {
        runId,
        jobId,
        error: toErrorMessage(err),
      });
    });
  }

  /** Restart a rerouted job's spawn window for one more worker attempt plus its backoff. */
  private async rearmAfterSpawnRetry(
    runId: string,
    jobId: string,
    tracked: RerouteTracking,
  ): Promise<void> {
    const windowMs = await this.getRerouteSpawnWindowMs(tracked.job);
    // A first progress (clears the timer) or a re-dispatch (drops the entry) that
    // landed during the read already settled this window: leave it settled.
    if (this.reroutedJobs.get(runId)?.get(jobId) !== tracked || tracked.windowTimer === undefined) {
      return;
    }
    clearTimeout(tracked.windowTimer);
    tracked.windowTimer = this.armRerouteWindow(
      runId,
      jobId,
      windowMs + tracked.spawnRetry.backoffMs,
    );
  }

  /**
   * Apply a peer's job completion. onJobStatus fires the needs-aware scheduler
   * hook, which dispatches newly-ready downstream jobs via onJobReadyCallback.
   * `data` carries droppedJobs for drift reporting.
   */
  onPeerJobComplete(
    runId: string,
    jobId: string,
    status: string,
    timestamp: number,
    data?: Record<string, unknown>,
  ): void {
    if (this.executionTracker) {
      this.executionTracker
        .onJobStatus(runId, jobId, status, timestamp, undefined, data)
        .catch((err) => {
          logger.error('Failed to track peer job completion', {
            error: toErrorMessage(err),
            runId,
            jobId,
          });
        });
    }

    const runJobs = this.reroutedJobs.get(runId);
    if (runJobs) {
      const entry = runJobs.get(jobId);
      if (entry?.windowTimer) clearTimeout(entry.windowTimer);
      runJobs.delete(jobId);
      if (runJobs.size === 0) {
        this.reroutedJobs.delete(runId);
      }
    }
  }

  /**
   * Send peer.job.cancel for every rerouted job of a run. Graceful: the peer
   * finishes the current step and cancels the remaining ones.
   */
  cancelRun(runId: string, reason: string): void {
    const runJobs = this.reroutedJobs.get(runId);
    if (!runJobs) return;

    // Disarm each spawn-window timer so a cancelled run cannot trigger a spurious re-dispatch.
    const peerJobs = new Map<string, string[]>();
    for (const [jobId, info] of runJobs) {
      if (info.windowTimer) {
        clearTimeout(info.windowTimer);
        info.windowTimer = undefined;
      }
      let jobs = peerJobs.get(info.peerId);
      if (!jobs) {
        jobs = [];
        peerJobs.set(info.peerId, jobs);
      }
      jobs.push(jobId);
    }

    for (const [peerId, jobIds] of peerJobs) {
      for (const jobId of jobIds) {
        const cancelMsg: PeerJobCancel = {
          type: 'peer.job.cancel',
          runId,
          jobId,
          reason,
        };
        const sent = this.sendToPeer(peerId, cancelMsg);
        if (!sent) {
          logger.warn('Failed to send cancel to peer', { peerId, runId, jobId });
        }
      }
    }

    logger.info('Cancel propagated to peers', {
      runId,
      reason,
      peerCount: peerJobs.size,
    });
  }

  hasConnectedPeers(): boolean {
    return this.peerRegistry.getConnectedPeerCount() > 0;
  }

  /** Evict stale peers every staleTimeoutMs/2. */
  startStaleEvictionTimer(staleTimeoutMs: number): void {
    if (this.staleEvictionTimer) {
      clearInterval(this.staleEvictionTimer);
    }

    this.staleEvictionTimer = setInterval(() => {
      const evicted = this.peerRegistry.evictStalePeers(staleTimeoutMs);
      if (evicted.length > 0) {
        logger.warn('Evicted stale peers', { evicted, count: evicted.length });
      }
    }, staleTimeoutMs / 2);
  }

  stopStaleEvictionTimer(): void {
    if (this.staleEvictionTimer) {
      clearInterval(this.staleEvictionTimer);
      this.staleEvictionTimer = null;
    }
  }

  /** Used in tests. */
  getNakCount(peerId: string): number {
    return this.nakTracker.get(peerId)?.count ?? 0;
  }

  /** Used in tests. */
  getBackoffUntil(peerId: string): number {
    return this.nakTracker.get(peerId)?.backoffUntil ?? 0;
  }

  // --- Private ---

  /** Allocate the sender-side jobId and delegate to {@link attemptPeerRoute}. */
  private async rerouteJob(
    runContext: RunContext,
    job: JobToRoute,
    labelSets: string[][],
  ): Promise<{ success: boolean; peerId?: string; jobId?: string; reason?: string }> {
    // Pre-allocated so the execution rows exist under it before the worker
    // reports back: a worker-generated id matches no run+job row here
    // (recoverRunFromDb returns null), its progress is silently dropped, and the
    // run stalls at `running` forever.
    const allocatedJobId = randomUUID();
    return this.attemptPeerRoute(runContext, job, labelSets, allocatedJobId, [this.instanceId]);
  }

  /**
   * Try each peer with matching capacity (most first) for one job under a fixed
   * `jobId`, returning on the first ACK. Used by initial routing and the spawn
   * backstop; the caller passes the accumulated `triedConnections` (this
   * instance + any failed peers) so a re-dispatch never re-selects a failed peer
   * and the receiving peer's loop-prevention stays correct.
   */
  private async attemptPeerRoute(
    runContext: RunContext,
    job: JobToRoute,
    labelSets: string[][],
    jobId: string,
    triedConnections: string[],
  ): Promise<{ success: boolean; peerId?: string; jobId?: string; reason?: string }> {
    const peers = this.peerRegistry.findPeersWithCapacity(labelSets);

    if (peers.length === 0) {
      return this.noCapacityResult(job, labelSets);
    }

    const sortedPeers = this.sortPeersByCapacity(peers, labelSets);
    const maxHops = await this.getRerouteMaxHops(job);
    const ackTimeoutMs = await this.getRerouteAckTimeoutMs(job);
    const spawnRetry = await this.getRerouteSpawnRetry(job);
    const now = Date.now();

    for (const peer of sortedPeers) {
      if (triedConnections.includes(peer.instanceId)) continue;

      const nakEntry = this.nakTracker.get(peer.instanceId);
      if (nakEntry && nakEntry.backoffUntil > now) {
        logger.debug('Skipping peer in NAK backoff', {
          peerId: peer.instanceId,
          jobName: job.jobName,
          backoffRemainingMs: nakEntry.backoffUntil - now,
        });
        continue;
      }

      const transport = this.rerouteTransport(peer.instanceId);
      if (transport === null) {
        logger.warn('No link to peer (found in registry but no connection)', {
          peerId: peer.instanceId,
          jobName: job.jobName,
        });
        continue;
      }

      const rerouteMsg = this.buildRerouteMessage(runContext, job, labelSets, jobId, {
        triedConnections,
        maxHops,
        spawnRetry,
      });

      const accepted =
        transport === 'client'
          ? await this.getPeerClient(peer.instanceId)!.sendAndWaitAck(rerouteMsg, ackTimeoutMs)
          : await this.sendAndWaitAckViaHandler!(peer.instanceId, rerouteMsg, ackTimeoutMs);

      if (accepted) {
        this.nakTracker.delete(peer.instanceId);

        // Tracked under the *fixed* jobId the worker reports back. The durable
        // `rerouted_to_peer` marker is re-asserted in onPeerJobProgress: the
        // execution_jobs row does not exist yet at reroute-ACK time.
        await this.trackReroutedJob(runContext, job, labelSets, jobId, {
          peerId: peer.instanceId,
          triedConnections,
          spawnRetry,
        });

        logger.info('Job rerouted to peer', {
          runId: runContext.runId,
          jobName: job.jobName,
          jobId,
          peerId: peer.instanceId,
        });

        return { success: true, peerId: peer.instanceId, jobId };
      }

      const currentNak = this.nakTracker.get(peer.instanceId);
      const nakCount = (currentNak?.count ?? 0) + 1;
      const backoffMs = Math.min(NAK_BACKOFF_BASE_MS * Math.pow(2, nakCount), NAK_BACKOFF_MAX_MS);
      this.nakTracker.set(peer.instanceId, {
        count: nakCount,
        backoffUntil: Date.now() + backoffMs,
      });

      logger.warn('Peer NAKed job', {
        peerId: peer.instanceId,
        jobName: job.jobName,
        nakCount,
        backoffMs,
        transport,
      });
    }

    return {
      success: false,
      reason: 'All peers with capacity rejected or timed out',
    };
  }

  /** Tell "no peer handles this label" from "peers exist but at capacity". */
  private noCapacityResult(
    job: JobToRoute,
    labelSets: string[][],
  ): { success: false; reason: string } {
    const peersWithLabels = this.peerRegistry.findPeersWithLabels(labelSets);

    const allPeers = this.peerRegistry.getConnectedPeers();
    logger.debug('Reroute failed — peer registry state', {
      jobName: job.jobName,
      requiredLabels: labelSets,
      connectedPeers: allPeers.map((p) => ({
        id: p.instanceId,
        connected: p.connected,
        draining: p.draining,
        agents: p.agents.length,
        scalerCapacity: p.scalerCapacity?.map((sc) => ({
          labelSets: sc.labelSets,
          active: sc.activeCount,
          max: sc.maxAgents,
        })),
      })),
      peersWithLabelsCount: peersWithLabels.length,
    });

    if (peersWithLabels.length > 0) {
      return { success: false, reason: `Peers with matching labels exist but are at capacity` };
    }
    return {
      success: false,
      reason: `No orchestrator in cluster handles labels: ${labelSets.map((ls) => ls.join(',')).join(' | ')}`,
    };
  }

  /** Assemble the `job.reroute` wire message for a single routing attempt. */
  private buildRerouteMessage(
    runContext: RunContext,
    job: JobToRoute,
    labelSets: string[][],
    jobId: string,
    routing: { triedConnections: string[]; maxHops: number; spawnRetry: RerouteSpawnRetry },
  ): JobReroute {
    return {
      type: 'job.reroute',
      messageId: randomUUID(),
      jobId,
      runId: runContext.runId,
      deliveryId: runContext.deliveryId,
      routingKey: runContext.routingKey,
      event: runContext.event,
      action: runContext.action,
      payload: runContext.payload,
      jobName: job.jobName,
      workflowName: runContext.workflowName,
      runsOnLabels: labelSets,
      excludeLabels: job.excludeLabels,
      // A pure-regex job has no exact labels and would otherwise match any agent.
      runsOnPatterns: job.runsOnPatterns,
      excludePatterns: job.excludePatterns,
      triedConnections: routing.triedConnections,
      maxHops: routing.maxHops,
      spawnRetry: routing.spawnRetry,
      coordinatorId: this.instanceId,
      requestId: runContext.requestId,
      traceId: runContext.traceId,
      jobConfig: job.jobConfig,
      repoUrl: job.repoUrl,
      ref: job.ref,
      sha: job.sha,
      provider: runContext.provider,
      providerContext: runContext.installationId
        ? { installationId: runContext.installationId }
        : {},
      sourceTarUrl: job.sourceTarUrl,
      sourceTarDigest: job.sourceTarDigest,
      depsUrl: job.depsUrl,
      depsHash: job.depsHash,
      cloneToken: runContext.cloneToken,
      workflowCloneToken: runContext.workflowCloneToken,
    };
  }

  private sortPeersByCapacity(peers: PeerInfo[], labelSets: string[][]): PeerInfo[] {
    return [...peers].sort((a, b) => {
      const capacityA = this.computeAvailableCapacity(a, labelSets);
      const capacityB = this.computeAvailableCapacity(b, labelSets);
      return capacityB - capacityA; // Descending: most capacity first
    });
  }

  /**
   * Free capacity across a peer's matching agents. A gated agent counts only for
   * label sets that include every `mandatoryLabels` gate label, as the local
   * matcher does; otherwise the peer refuses the dispatch in
   * `AgentRegistry.findAvailable`.
   */
  private computeAvailableCapacity(peer: PeerInfo, labelSets: string[][]): number {
    let capacity = 0;
    for (const agent of peer.agents) {
      if (agent.activeJobs >= agent.maxConcurrency) continue;
      const agentLabels = new Set(agent.labels);
      const matches = labelSets.some((required) => {
        if (!agentSatisfiesMandatoryLabels(agent, required)) return false;
        if (required.length === 0) return true;
        return required.every((label) => agentLabels.has(label));
      });
      if (matches) {
        capacity += agent.maxConcurrency - agent.activeJobs;
      }
    }
    return capacity;
  }

  /**
   * Track a rerouted job, arm its spawn-window backstop, and durably tag its
   * `execution_jobs` row with the owning worker peer so run-recovery sweepers do
   * not force-fail the job while its worker is connected.
   */
  private async trackReroutedJob(
    runContext: RunContext,
    job: JobToRoute,
    labelSets: string[][],
    jobId: string,
    target: { peerId: string; triedConnections: string[]; spawnRetry: RerouteSpawnRetry },
  ): Promise<void> {
    const { peerId, triedConnections, spawnRetry } = target;
    const runId = runContext.runId;
    let runJobs = this.reroutedJobs.get(runId);
    if (!runJobs) {
      runJobs = new Map();
      this.reroutedJobs.set(runId, runJobs);
    }

    // Without progress in the window the timer re-dispatches, instead of
    // stranding the run until the ~20-min stale detector. Cleared on the first
    // progress (onPeerJobProgress) or on terminal cleanup.
    const windowTimer = this.armRerouteWindow(
      runId,
      jobId,
      await this.getRerouteSpawnWindowMs(job),
    );

    runJobs.set(jobId, {
      peerId,
      jobName: job.jobName,
      runContext,
      job,
      labelSets,
      triedConnections: [...triedConnections],
      peerStarted: false,
      windowTimer,
      spawnRetry,
      spawnFailures: 0,
    });

    if (this.executionTracker) {
      // The rerouted job is not in the tracker's run.jobs and has no local
      // dispatch_queue row, so without the seeded name the step-log path
      // resolver files its early relayed chunks under the bare jobId, unreadable.
      this.executionTracker.registerJobName(runId, jobId, job.jobName);
      await this.executionTracker.markJobReroutedToPeer(runId, jobId, peerId);
    }
  }

  /** Arm a spawn-window / reap timer that fires {@link handleRerouteSpawnTimeout}. */
  private armRerouteWindow(runId: string, jobId: string, windowMs: number): NodeJS.Timeout {
    return setTimeout(() => {
      void this.handleRerouteSpawnTimeout(runId, jobId).catch((err) => {
        logger.error('Reroute spawn-window handler failed', {
          runId,
          jobId,
          error: toErrorMessage(err),
        });
      });
    }, windowMs);
  }

  /**
   * Whether the reroute target has actually started the job, read from the
   * shared `execution_jobs` row.
   *
   * A read failure answers "not running" so a transient database fault cannot
   * silently disable the backstop; the re-dispatch it then performs is
   * idempotent. Only the FIRST observation goes through this path: once
   * `peerStarted` latches, a read fault can no longer bounce a running job.
   */
  private async rerouteTargetIsRunning(
    runId: string,
    jobId: string,
    tracked: RerouteTracking,
  ): Promise<boolean> {
    if (!this.executionTracker) return false;
    try {
      return await this.executionTracker.hasJobStarted(runId, jobId);
    } catch (err) {
      logger.warn('Could not read rerouted job state; treating the spawn window as elapsed', {
        runId,
        jobId,
        peerId: tracked.peerId,
        error: toErrorMessage(err),
      });
      return false;
    }
  }

  /**
   * The peer owns the job, so the backstop must not re-dispatch it. Release the
   * tracking entry once the shared row is terminal, otherwise re-arm the window
   * as a reap poll.
   *
   * The entry cannot be dropped: cancel propagation needs it while the job runs.
   * It cannot be kept: a peer COORDINATOR relays no terminal `job.progress` (the
   * shared row IS its report), so nothing else releases it and `reroutedJobs`
   * would grow for the process lifetime. A read fault re-arms (never releases),
   * so a transient fault costs one more poll rather than tracking.
   */
  private async reapOrDeferRerouteTracking(
    runId: string,
    jobId: string,
    runJobs: Map<string, RerouteTracking>,
    tracked: RerouteTracking,
  ): Promise<void> {
    if (tracked.windowTimer) clearTimeout(tracked.windowTimer);
    tracked.windowTimer = undefined;

    let terminal = false;
    try {
      terminal = (await this.executionTracker?.isJobTerminal(runId, jobId)) ?? false;
    } catch (err) {
      logger.warn('Could not read rerouted job state; keeping the tracking entry', {
        runId,
        jobId,
        peerId: tracked.peerId,
        error: toErrorMessage(err),
      });
    }

    if (terminal) {
      runJobs.delete(jobId);
      if (runJobs.size === 0) this.reroutedJobs.delete(runId);
      logger.info('Rerouted job reached a terminal state on its peer — tracking released', {
        runId,
        jobId,
        jobName: tracked.jobName,
        peerId: tracked.peerId,
      });
      this.fireIdleIfDrained(tracked.peerId);
      return;
    }

    tracked.windowTimer = this.armRerouteWindow(
      runId,
      jobId,
      await this.getRerouteSpawnWindowMs(tracked.job),
    );
    logger.info('Rerouted job is running on its peer — spawn-window backstop disarmed', {
      runId,
      jobId,
      jobName: tracked.jobName,
      peerId: tracked.peerId,
    });
  }

  /**
   * Post-ACK spawn-window backstop. Fires when a rerouted job's peer accepted
   * but produced no progress within the window (Layer A), or when a worker
   * relays its final spawn-failure verdict (Layer B, via onPeerScalerEvent).
   * Best-effort cancels the original peer (double-execution guard against a
   * slow-but-healthy spawn), then re-routes to another peer, then local, and
   * finally records the job failed rather than leaving it pending. Idempotent:
   * whichever trigger fires first removes the tracking entry.
   */
  private async handleRerouteSpawnTimeout(runId: string, jobId: string): Promise<void> {
    const runJobs = this.reroutedJobs.get(runId);
    const tracked = runJobs?.get(jobId);
    if (!runJobs || !tracked) return; // Progress arrived / already re-dispatched.

    // Silence on the wire is not evidence the spawn failed. Only a WORKER peer
    // (no database) relays the `job.progress` that disarms this timer; a peer
    // COORDINATOR writes straight to the shared `execution_jobs`, so any
    // coordinator-to-coordinator job that outlives the window (slow spawn, long
    // checkout, big dependency install) would be cancelled while running fine.
    //
    // So consult the shared row first and latch the answer: from then on the
    // entry is only deferred or reaped, never re-dispatched. With no tracker
    // wired, this reads false and the backstop re-dispatches.
    if (tracked.peerStarted || (await this.rerouteTargetIsRunning(runId, jobId, tracked))) {
      tracked.peerStarted = true;
      await this.reapOrDeferRerouteTracking(runId, jobId, runJobs, tracked);
      return;
    }

    // Remove tracking + clear the timer BEFORE re-dispatch so a concurrent
    // trigger (Layer A window vs. Layer B NAK) sees the entry gone and no-ops.
    if (tracked.windowTimer) clearTimeout(tracked.windowTimer);
    runJobs.delete(jobId);
    if (runJobs.size === 0) this.reroutedJobs.delete(runId);

    logger.warn('Rerouted job produced no progress — re-dispatching', {
      runId,
      jobId,
      jobName: tracked.jobName,
      failedPeerId: tracked.peerId,
    });

    this.cancelPeerJob(tracked.peerId, runId, jobId, 'reroute spawn window elapsed');

    const nextTried = [...tracked.triedConnections, tracked.peerId];
    const result = await this.attemptPeerRoute(
      tracked.runContext,
      tracked.job,
      tracked.labelSets,
      jobId,
      nextTried,
    );
    if (result.success) return;

    // No peer accepted: the coordinator may have capacity now. Same jobId, so the
    // execution row is reused.
    const localOk = await this.tryLocalRedispatch(tracked.runContext, tracked.job, jobId);
    if (localOk) return;

    // Unroutable everywhere: fail now rather than leave it pending for the stale detector.
    await this.failUnroutableJob(runId, jobId, tracked.jobName);
  }

  /** Best-effort cancel a single job on a peer (double-execution guard). */
  private cancelPeerJob(peerId: string, runId: string, jobId: string, reason: string): void {
    if (!this.cancelJobOnPeer(peerId, runId, jobId, reason)) {
      logger.warn('Failed to send re-dispatch cancel to peer', { peerId, runId, jobId });
    }
  }

  /**
   * Forward `job.cancel` for ONE job to the coordinator that holds its agent's
   * socket, reporting whether the message left this process.
   *
   * The run-cancel path needs this for a job this coordinator never routed:
   * the Platform picks any pool member to receive `run.cancel.request`, and only
   * the coordinator holding the agent's socket can put a cancel frame on it.
   * `force` rides on the message, so a force cancel stays forced on the peer.
   * {@link RunCoordinator.cancelRun} covers rerouted jobs.
   */
  cancelJobOnPeer(
    peerId: string,
    runId: string,
    jobId: string,
    reason: string,
    force?: boolean,
  ): boolean {
    const cancelMsg: PeerJobCancel = {
      type: 'peer.job.cancel',
      runId,
      jobId,
      reason,
      ...(force && { force: true }),
    };
    return this.sendToPeer(peerId, cancelMsg);
  }

  /**
   * Fire-and-forget to a peer: over the outbound client when connected, else
   * over the peer's own connection to this process. The outbound client is down
   * while it reconnects, and for good on a coordinator whose credential an
   * operator revoked. `PeerClient.send` returns false only when it sent nothing,
   * so the fallback never delivers a message twice.
   */
  private sendToPeer(peerId: string, msg: PeerToPeerMessage): boolean {
    const client = this.getPeerClient(peerId);
    if (client?.send(msg)) return true;
    return this.sendToPeerViaHandler?.(peerId, msg) ?? false;
  }

  /**
   * The link a reroute uses, chosen before sending. A reroute is never retried
   * over the second link: `false` from a connected client is a NAK or an ack
   * timeout, and resending would deliver the job twice.
   */
  private rerouteTransport(peerId: string): 'client' | 'handler' | null {
    if (this.getPeerClient(peerId)?.state === 'connected') return 'client';
    return this.sendAndWaitAckViaHandler ? 'handler' : null;
  }

  /** Re-dispatch locally under the existing jobId; true when the dispatcher accepts it. */
  private async tryLocalRedispatch(
    runContext: RunContext,
    job: JobToRoute,
    jobId: string,
  ): Promise<boolean> {
    const flatLabels = job.runsOnLabels.length > 0 ? job.runsOnLabels[0] : [];
    const jobInput: QueuedJobInput = {
      jobId,
      runId: runContext.runId,
      workflowName: runContext.workflowName,
      jobName: job.jobName,
      runsOnLabels: flatLabels,
      runsOnPatterns: job.runsOnPatterns,
      excludePatterns: job.excludePatterns,
      excludeLabels: job.excludeLabels,
      jobConfig: job.jobConfig,
      repoUrl: job.repoUrl,
      ref: job.ref,
      sha: job.sha,
      deliveryId: runContext.deliveryId,
      provider: runContext.provider,
      providerContext: runContext.installationId
        ? { installationId: runContext.installationId }
        : {},
      routingKey: runContext.routingKey,
      sourceTarUrl: job.sourceTarUrl,
      sourceTarDigest: job.sourceTarDigest,
      depsUrl: job.depsUrl,
      depsHash: job.depsHash,
      requestId: runContext.requestId,
      ...(job.resources && { resources: job.resources }),
    };
    const result = await this.dispatcher.dispatch(jobInput);
    if (result.status === 'duplicate') {
      // Already queued/dispatched under this jobId: an idempotent success.
      return true;
    }
    if (result.status === 'rejected' || result.status === 'queued-no-backend') {
      if (result.status === 'queued-no-backend') {
        // Cancel the no-backend fallback entry; it would sit queued forever.
        await this.dispatcher.cancelQueuedJob(result.jobId, 'reroute re-dispatch unroutable');
      }
      return false;
    }
    logger.info('Rerouted job re-dispatched locally', {
      runId: runContext.runId,
      jobId,
      jobName: job.jobName,
    });
    return true;
  }

  /** Mark a job failed when no backend (peer or local) can run it after re-dispatch. */
  private async failUnroutableJob(runId: string, jobId: string, jobName: string): Promise<void> {
    logger.error('Rerouted job unroutable after spawn failure — failing it', {
      runId,
      jobId,
      jobName,
    });
    if (this.executionTracker) {
      await this.executionTracker
        .onJobStatus(runId, jobId, ExecutionJobStatus.enum.failed, Date.now(), undefined, {
          reason: 'reroute re-dispatch found no available backend after spawn failure',
        })
        .catch((err) => {
          logger.error('Failed to record unroutable-job failure', {
            runId,
            jobId,
            error: toErrorMessage(err),
          });
        });
    }
  }
}

/**
 * Per-agent mandatory-labels gate (Kubernetes-taint-style): `true` when every
 * label in `agent.mandatoryLabels` appears in `requiredLabels`, or when there
 * are none.
 *
 * Must match `peerAgentMatchesRequiredLabels` in `peer-registry.ts`, or the
 * coordinator over-counts gated agents when ranking peers for an off-gate
 * label set.
 *
 * Both sides are already canonical: `agent.mandatoryLabels` is folded in
 * `PeerRegistry.updateHeartbeat`, `requiredLabels` at the job's ingress. This
 * folds nothing itself; a raw label from a new source would silently
 * under-count, and the fix is to fold at that source.
 */
function agentSatisfiesMandatoryLabels(
  agent: { mandatoryLabels?: string[] },
  requiredLabels: string[],
): boolean {
  const mandatory = agent.mandatoryLabels;
  if (!mandatory || mandatory.length === 0) return true;
  if (requiredLabels.length === 0) return false;
  const required = new Set(requiredLabels);
  return mandatory.every((m) => required.has(m));
}
