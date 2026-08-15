/**
 * Run coordinator for multi-orchestrator job routing.
 *
 * The receiving orchestrator becomes the run coordinator: it claims jobs
 * it can dispatch locally and reroutes others to peers based on agent
 * inventory. Per locked decisions:
 * - "One orchestrator coordinates per webhook run"
 * - "Claim-based splitting"
 * - "Coordinator handles ALL check run reporting"
 * - "Peers report step-by-step progress back to coordinator"
 * - "Cancel mode: graceful -- finish current step, cancel remaining"
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
  ResourceRequest,
  LabelMatcher,
} from '@kici-dev/engine';
import { TERMINAL_JOB_STATES, ExecutionJobStatus, ScalerEventType } from '@kici-dev/engine';
import type { PeerRegistry, PeerInfo } from './peer-registry.js';
import type { PeerClient } from './peer-client.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import type { QueuedJobInput } from '../queue/job-queue.js';

const logger = createLogger({ prefix: 'coordinator' });

/** Default ACK timeout for rerouted jobs (15s per locked decision). */
const DEFAULT_ACK_TIMEOUT_MS = 15_000;

/** Maximum allowed hops for rerouted jobs to prevent routing loops. */
const DEFAULT_MAX_HOPS = 3;

/**
 * Default reroute spawn window (90s): how long the coordinator waits after a
 * peer ACKs a reroute before treating "accepted but no progress" as a spawn
 * failure and re-dispatching. Fallback when no per-org / cluster reader is
 * wired (tests, minimal deps); production reads it from
 * `org_settings.reroute_spawn_window_ms` / `config.rerouteSpawnWindowMs`.
 */
const DEFAULT_REROUTE_SPAWN_WINDOW_MS = 90_000;

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
  sourceTarHash?: string;
  depsUrl?: string;
  depsHash?: string;
  /** Labels that the dispatched agent must NOT have. */
  excludeLabels?: string[];
  /**
   * Per-job resource request and limit (K8s-style). Forwarded to
   * `Dispatcher.dispatch()` so the scaler's per-scaler / per-orchestrator /
   * per-machine cap accounting sees the typed value rather than relying on
   * the `jobConfig.resources` JSON blob (which the dispatcher does not parse).
   */
  resources?: ResourceRequest;
}

export interface RouteResult {
  localJobs: Array<{ jobName: string; jobId: string }>;
  /**
   * Rerouted jobs include the pre-allocated jobId so the caller can
   * register the execution_runs / execution_jobs rows under the same id
   * the worker will report progress against.
   */
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
  ackTimeoutMs?: number;
  /** Stale peer timeout in ms. Default: 60000 (60s). */
  staleTimeoutMs?: number;
  /**
   * Per-job reroute spawn window (ms): the post-ACK re-dispatch backstop
   * window. Resolves the job's org override from
   * `org_settings.reroute_spawn_window_ms`, else the cluster default. When
   * absent, {@link DEFAULT_REROUTE_SPAWN_WINDOW_MS} is used.
   */
  getRerouteSpawnWindowMs?: (job: JobToRoute) => Promise<number>;
  /**
   * Per-job reroute ACK timeout (ms) for the `sendAndWaitAck` deadline. When
   * absent, falls back to `ackTimeoutMs` / {@link DEFAULT_ACK_TIMEOUT_MS}.
   */
  getRerouteAckTimeoutMs?: (job: JobToRoute) => Promise<number>;
  /**
   * Per-job maximum peer hops for a rerouted job. When absent, falls back to
   * {@link DEFAULT_MAX_HOPS}.
   */
  getRerouteMaxHops?: (job: JobToRoute) => Promise<number>;
}

/**
 * In-memory tracking for a job rerouted to a peer. Retains everything the
 * post-ACK re-dispatch backstop needs to re-run the routing decision (to
 * another peer or a local fallback) when the receiving peer accepts the
 * reroute but never reports progress (async spawn failure, peer crash).
 */
interface RerouteTracking {
  peerId: string;
  jobName: string;
  runContext: RunContext;
  job: JobToRoute;
  labelSets: string[][];
  /** Connections already tried (this instance + every failed peer), for loop prevention. */
  triedConnections: string[];
  /** Armed spawn-window timer; cleared on first progress or terminal cleanup. */
  windowTimer: NodeJS.Timeout | undefined;
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

  /**
   * Tracks which jobs have been rerouted to which peers, keyed by runId.
   * Used for cancel propagation, progress tracking, and the post-ACK spawn
   * re-dispatch backstop.
   */
  private readonly reroutedJobs = new Map<string, Map<string, RerouteTracking>>();

  /**
   * NAK tracking per peer: count of consecutive NAKs and backoff-until timestamp.
   * Peers that repeatedly NAK are deprioritized via exponential backoff.
   */
  private readonly nakTracker = new Map<string, { count: number; backoffUntil: number }>();

  /** Stale eviction timer handle. */
  private staleEvictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: RunCoordinatorDeps) {
    this.instanceId = deps.instanceId;
    this.peerRegistry = deps.peerRegistry;
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
  }

  /**
   * Route jobs for a webhook run. Claims jobs that local agents can handle,
   * reroutes the rest to peers with matching capacity.
   *
   * Parallel fan-out: jobs targeting different peers are rerouted concurrently.
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
    // The Dispatcher checks connected agents first, then consults the scaler
    // (via onNoMatchingAgent) which can spawn on-demand agents. This ensures
    // jobs matching a local scaler backend (e.g. runsOn: 'container') are
    // handled locally instead of being rerouted to peers or failing.
    // Only if the Dispatcher rejects (no agent AND no scaler backend) do we
    // attempt to reroute to peers.
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
        sourceTarHash: job.sourceTarHash,
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
        // Job queued locally as fallback, but no backend can handle it -- try
        // peers first; if a peer accepts, cancel the local fallback entry.
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
            // Cancel the local fallback queue entry since a peer accepted the job
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

  /**
   * Handle a job reroute request received from a peer (this instance is the worker).
   * Checks loop prevention, then attempts to dispatch locally.
   */
  async handleIncomingReroute(msg: JobReroute): Promise<{ accepted: boolean; reason?: string }> {
    // Loop prevention: check if we already tried this job
    if (msg.triedConnections.includes(this.instanceId)) {
      return { accepted: false, reason: 'Loop detected' };
    }

    // Max hops check
    if (msg.triedConnections.length >= msg.maxHops) {
      return { accepted: false, reason: 'Max hops exceeded' };
    }

    const flatLabels = msg.runsOnLabels.length > 0 ? msg.runsOnLabels[0] : [];

    // Dispatch locally using the resolved job data from the reroute message.
    // NOTE: We dispatch through the Dispatcher (not via agentRegistry.findAvailable)
    // because the Dispatcher triggers the scaler to spawn on-demand agents when none
    // are currently registered. Checking agentRegistry first would reject reroutes
    // to orchestrators that have scaler capacity but no pre-existing agents.
    const jobInput: QueuedJobInput = {
      // Honor the sender-allocated jobId so progress updates from this
      // coord's agents reference the same id the sender wrote into its DB.
      jobId: msg.jobId,
      runId: msg.runId,
      workflowName: msg.workflowName,
      jobName: msg.jobName,
      runsOnLabels: flatLabels,
      excludeLabels: msg.excludeLabels,
      // Carry the glob/regex selectors through to local dispatch so the
      // Dispatcher's findAvailable 4-tuple applies the same matching the
      // single-orchestrator path does — a pure-regex job must not match an
      // agent lacking the pattern just because it carries no exact labels.
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
      sourceTarHash: msg.sourceTarHash,
      depsUrl: msg.depsUrl,
      depsHash: msg.depsHash,
    };

    // Extract repo identity fields needed for execution tracking and check runs
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

    // Create check runs on GitHub BEFORE dispatching, so that when the job
    // completes, the CheckRunReporter can find the check run IDs to update.
    // Without this, the reporter logs "Check run ID not found" and the check
    // run is never updated to success/failure.
    // We use setPendingAwait (not fire-and-forget setPending) because the check
    // run IDs MUST be stored in memory before the job completes.
    if (this.checkRunReporter && repoIdentifier && msg.sha) {
      const [owner, repo] = repoIdentifier.split('/');
      // The repository that DEFINES the workflow, carried per job for an
      // organization-wide workflow. No such job can reach here today — a global
      // candidate is enqueued straight through `dispatcher.dispatch` and never
      // passes through `routeJobs`, which is the only sender of the peer
      // `job.reroute` this handler answers. Read it anyway: a create whose name
      // was not qualified would carry the acted-on repository's name and post a
      // second check run under it — see `CheckRunReporter.workflowLabel`, which
      // drops the qualifier when the two repositories are the same, so this is
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
          // Best-effort: check run creation failure shouldn't reject the reroute.
          // The job will still execute, just without GitHub check run updates.
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
      // A dispatch_queue row for this jobId already exists here — a concurrent
      // reroute from the sibling coordinator, or a duplicate delivery. The job is
      // already tracked; accept the reroute without re-registering local execution
      // tracking or double-dispatching. (Idempotent no-op, not an error.)
      return { accepted: true };
    }

    // Register the execution run locally so this orchestrator's ExecutionTracker
    // can track job completion and update the GitHub check run. Without this,
    // the check run would never be updated because the coordinator (sender) has
    // the tracker but can't observe the job status on this instance.
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
        // Best-effort: execution tracking failure shouldn't reject the reroute.
        // The in-memory tracking in ExecutionTracker is set before the DB insert,
        // so even if the DB insert fails (e.g. duplicate key from coordinator),
        // the in-memory state enables check run updates via onExecutionComplete.
        logger.warn('Failed to register rerouted execution for tracking', {
          runId: msg.runId,
          error: toErrorMessage(err),
        });
      }
    }

    return { accepted: true };
  }

  /**
   * Handle peer job/step progress updates from a worker (or coord) peer.
   *
   * The discriminator `msg.kind` decides which downstream tracker call to
   * make: 'job' updates feed `onJobStatus` (the path that drives run-level
   * state transitions and the rerouted-job cleanup); 'step' updates feed
   * `onStepStatus` (which only persists `execution_steps` rows). Without
   * this split, every job-level event was silently funnelled into
   * `onStepStatus` and the run stayed in `running` forever.
   */
  onPeerJobProgress(
    msg: JobProgress,
    fromPeerId: string,
    reply?: (m: JobProgressAck) => void,
  ): void {
    const tracked = this.reroutedJobs.get(msg.runId)?.get(msg.jobId);
    const isJobTerminal = msg.kind === 'job' && TERMINAL_JOB_STATES.has(msg.state);
    // A terminal relayed by a peer that is NOT the one this job is currently
    // tracked against is a stray signal from a superseded peer after a reroute
    // moved the job to a replacement. Ignoring its apply + cleanup keeps it from
    // (1) terminalizing the run while the replacement is still executing and
    // (2) stripping the replacement's spawn-window backstop. We still ACK it
    // (below) so the superseded peer prunes its durable outbox and stops
    // re-sending — a re-send after the replacement's own cleanup would otherwise
    // find no tracked entry and fall through to the unconditional apply.
    const isSupersededTerminal =
      isJobTerminal && tracked !== undefined && tracked.peerId !== fromPeerId;

    // First progress from the tracked reroute TARGET means its spawn succeeded —
    // disarm the post-ACK spawn-window backstop so it does not re-dispatch a
    // healthy job. Gate on the source peer: a stray progress relayed for the same
    // jobId by a superseded/cancelled peer must NOT disarm the replacement peer's
    // window timer (that would strip the backstop off a job still spawning).
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
      // Ack without applying, so the superseded peer prunes its durable outbox
      // and stops re-sending this stale terminal.
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
          // Re-assert the durable `rerouted_to_peer` marker now that the
          // worker's status has created the execution_jobs row. The
          // reroute-time markJobReroutedToPeer UPDATE (in trackReroutedJob)
          // ran before the row existed — a rerouted job's row is created
          // lazily by the worker's FIRST status update, which arrives seconds
          // after the reroute ACK — so that UPDATE matched zero rows and the
          // marker was silently dropped. Without the marker the run-recovery
          // sweepers' defer guard cannot see that the job belongs to a worker
          // peer and force-fail it the moment its heartbeat goes stale.
          // Idempotent and cheap; skipped on terminal updates (the marker is
          // moot once the job is done, and reroutedJobs is cleared below).
          const trackedNow = this.reroutedJobs.get(msg.runId)?.get(msg.jobId);
          if (trackedNow && this.executionTracker && !TERMINAL_JOB_STATES.has(msg.state)) {
            await this.executionTracker.markJobReroutedToPeer(
              msg.runId,
              msg.jobId,
              trackedNow.peerId,
            );
          }

          // ACK a terminal job-level update back to the worker only after the
          // tracker apply resolves. The worker uses this to prune its durable
          // outbox. Replayed terminals (already-applied) still resolve and so
          // still ack, which lets the worker prune after a coordinator restart.
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

    // Clean up rerouted-job tracking on terminal job-level updates so
    // cancel propagation and any "all jobs done" probes see the right
    // residual set. Skipped for a superseded-peer terminal: the replacement
    // peer still owns the job, so its tracking entry (and spawn-window timer)
    // must survive.
    if (isJobTerminal && !isSupersededTerminal) {
      const runJobs = this.reroutedJobs.get(msg.runId);
      if (runJobs) {
        const entry = runJobs.get(msg.jobId);
        if (entry?.windowTimer) clearTimeout(entry.windowTimer);
        runJobs.delete(msg.jobId);
        if (runJobs.size === 0) {
          this.reroutedJobs.delete(msg.runId);
        }
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
   * Handle a scaler provisioning event forwarded by a worker peer.
   *
   * Workers have no database, so they relay scaler events for jobs the
   * worker is provisioning to the coordinator that owns the run. The
   * coordinator's ExecutionTracker persists the event (provisioning log
   * line + dispatch-queue last-error column) just as it would for a
   * locally-emitted scaler event.
   *
   * Layer B fast path: a `scaler.failed` for a tracked rerouted job whose spawn
   * window is still armed is the worker's NAK-after-accept — the peer accepted
   * the reroute but its agent spawn failed asynchronously before reporting any
   * progress. Re-dispatch immediately (the same routine the spawn-window timer
   * runs) instead of waiting the window out. Idempotent with the Layer A timer:
   * whichever fires first removes the tracking entry.
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

    // Layer B NAK fast path — gated on source provenance AND an armed window.
    // Re-dispatch only when the failure comes from the peer this job is actually
    // tracked against: a late scaler.failed relayed for the same jobId by a
    // superseded peer (after an earlier re-dispatch moved the job) must NOT
    // bounce the healthy replacement. The armed-window check additionally keeps
    // a failure that arrives after first progress from cancelling a running job.
    const tracked = this.reroutedJobs.get(msg.runId)?.get(msg.jobId);
    if (
      msg.eventType === ScalerEventType.enum['scaler.failed'] &&
      tracked?.windowTimer !== undefined &&
      tracked.peerId === fromPeerId
    ) {
      logger.warn('Worker relayed scaler.failed for a rerouted job — re-dispatching', {
        runId: msg.runId,
        jobId: msg.jobId,
        detail: msg.detail,
      });
      void this.handleRerouteSpawnTimeout(msg.runId, msg.jobId).catch((err) => {
        logger.error('Reroute NAK-fast-path handler failed', {
          runId: msg.runId,
          jobId: msg.jobId,
          error: toErrorMessage(err),
        });
      });
    }
  }

  /**
   * Handle peer job completion. Updates ExecutionTracker.
   * The execution tracker's onJobStatus fires the needs-aware scheduler hook,
   * which evaluates downstream jobs and dispatches newly-ready ones via onJobReadyCallback.
   * The data parameter carries droppedJobs for drift reporting.
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

    // Clean up rerouted job tracking (disarm any live spawn-window timer first)
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
   * Cancel all rerouted jobs for a run. Sends peer.job.cancel to all
   * peers that have jobs for this run.
   *
   * Per locked decision: "graceful -- finish current step, cancel remaining."
   */
  cancelRun(runId: string, reason: string): void {
    const runJobs = this.reroutedJobs.get(runId);
    if (!runJobs) return;

    // Group jobs by peer for efficient messaging; disarm each job's spawn-window
    // timer so a cancelled run cannot trigger a spurious re-dispatch.
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

    // Send cancel to each peer
    for (const [peerId, jobIds] of peerJobs) {
      const client = this.getPeerClient(peerId);

      for (const jobId of jobIds) {
        const cancelMsg: PeerJobCancel = {
          type: 'peer.job.cancel',
          runId,
          jobId,
          reason,
        };
        const sent = client
          ? client.send(cancelMsg)
          : (this.sendToPeerViaHandler?.(peerId, cancelMsg as PeerToPeerMessage) ?? false);
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

  /**
   * Check if the peer registry has any connected peers.
   */
  hasConnectedPeers(): boolean {
    return this.peerRegistry.getConnectedPeerCount() > 0;
  }

  /**
   * Start the stale eviction timer. Calls peerRegistry.evictStalePeers()
   * every staleTimeoutMs/2 to detect and remove stale peers.
   */
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

  /**
   * Stop the stale eviction timer.
   */
  stopStaleEvictionTimer(): void {
    if (this.staleEvictionTimer) {
      clearInterval(this.staleEvictionTimer);
      this.staleEvictionTimer = null;
    }
  }

  /**
   * Get the NAK count for a peer (used in tests).
   */
  getNakCount(peerId: string): number {
    return this.nakTracker.get(peerId)?.count ?? 0;
  }

  /**
   * Get the backoff-until timestamp for a peer (used in tests).
   */
  getBackoffUntil(peerId: string): number {
    return this.nakTracker.get(peerId)?.backoffUntil ?? 0;
  }

  // --- Private ---

  /**
   * Attempt to reroute a job to a peer with matching capacity. Allocates the
   * sender-side jobId (so the caller can register execution rows under the id
   * the worker reports back against) and delegates to {@link attemptPeerRoute}.
   */
  private async rerouteJob(
    runContext: RunContext,
    job: JobToRoute,
    labelSets: string[][],
  ): Promise<{ success: boolean; peerId?: string; jobId?: string; reason?: string }> {
    // Pre-allocate the jobId on the sender side so we can register the
    // execution_runs + execution_jobs rows before the worker reports back.
    // Without this, the worker generates its own jobId and the first
    // peer.job.progress arriving at this coord finds no matching run+job row
    // (recoverRunFromDb returns null) and is silently dropped — leaving the
    // run stalled at `running` forever.
    const allocatedJobId = randomUUID();
    return this.attemptPeerRoute(runContext, job, labelSets, allocatedJobId, [this.instanceId]);
  }

  /**
   * Try each peer with matching capacity (most capacity first) for a single
   * job under a fixed `jobId`, returning on the first ACK. Reused by initial
   * routing and by the post-ACK spawn re-dispatch backstop — the caller passes
   * the accumulated `triedConnections` (this instance + any failed peers) so a
   * re-dispatch never re-selects a peer that already failed and the receiving
   * peer's loop-prevention stays correct.
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

    // Sort by available capacity (most capacity first)
    const sortedPeers = this.sortPeersByCapacity(peers, labelSets);
    const maxHops = await this.getRerouteMaxHops(job);
    const ackTimeoutMs = await this.getRerouteAckTimeoutMs(job);
    const now = Date.now();

    for (const peer of sortedPeers) {
      // Skip peers already tried for this job (the sender itself, or a peer that
      // accepted then failed to spawn) so a re-dispatch fans out to a new backend.
      if (triedConnections.includes(peer.instanceId)) continue;

      // Check NAK backoff: skip peers that are in backoff period
      const nakEntry = this.nakTracker.get(peer.instanceId);
      if (nakEntry && nakEntry.backoffUntil > now) {
        logger.debug('Skipping peer in NAK backoff', {
          peerId: peer.instanceId,
          jobName: job.jobName,
          backoffRemainingMs: nakEntry.backoffUntil - now,
        });
        continue;
      }

      const client = this.getPeerClient(peer.instanceId);
      const canSendViaHandler = !client && this.sendAndWaitAckViaHandler;
      if (!client && !canSendViaHandler) {
        logger.warn('No PeerClient for peer (found in registry but no connection)', {
          peerId: peer.instanceId,
          jobName: job.jobName,
        });
        continue;
      }

      const rerouteMsg = this.buildRerouteMessage(runContext, job, labelSets, jobId, {
        triedConnections,
        maxHops,
      });

      const accepted = client
        ? await client.sendAndWaitAck(rerouteMsg, ackTimeoutMs)
        : await this.sendAndWaitAckViaHandler!(peer.instanceId, rerouteMsg, ackTimeoutMs);

      if (accepted) {
        // ACK: reset NAK tracking for this peer
        this.nakTracker.delete(peer.instanceId);

        // Track rerouted job under the *fixed* jobId so cancel propagation, the
        // onPeerJobProgress residual-cleanup path, and the spawn-window backstop
        // all key off the same id the worker reports back. The durable
        // `rerouted_to_peer` marker is (re)asserted in onPeerJobProgress once
        // the worker's first status creates the execution_jobs row (the row does
        // not exist yet at reroute-ACK time, so a marker write here would be a
        // no-op UPDATE).
        await this.trackReroutedJob(
          runContext,
          job,
          labelSets,
          jobId,
          peer.instanceId,
          triedConnections,
        );

        logger.info('Job rerouted to peer', {
          runId: runContext.runId,
          jobName: job.jobName,
          jobId,
          peerId: peer.instanceId,
        });

        return { success: true, peerId: peer.instanceId, jobId };
      }

      // NAK: increment count and set exponential backoff
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
        clientState: client?.state ?? 'handler',
      });
    }

    return {
      success: false,
      reason: 'All peers with capacity rejected or timed out',
    };
  }

  /** Build the failure result when no peer has matching capacity (with debug log). */
  private noCapacityResult(
    job: JobToRoute,
    labelSets: string[][],
  ): { success: false; reason: string } {
    // Differentiate between "no peer handles this label" vs "peers exist but at capacity"
    const peersWithLabels = this.peerRegistry.findPeersWithLabels(labelSets);

    // Debug: log peer registry state when reroute fails
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
    routing: { triedConnections: string[]; maxHops: number },
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
      // Thread the glob/regex selectors so a pattern-bearing job keeps its
      // matchers on the receiving peer (a pure-regex job has no exact labels
      // and would otherwise match any local agent).
      runsOnPatterns: job.runsOnPatterns,
      excludePatterns: job.excludePatterns,
      triedConnections: routing.triedConnections,
      maxHops: routing.maxHops,
      coordinatorId: this.instanceId,
      requestId: runContext.requestId,
      traceId: runContext.traceId,
      // Include resolved job data so the receiving orch can dispatch directly
      jobConfig: job.jobConfig,
      repoUrl: job.repoUrl,
      ref: job.ref,
      sha: job.sha,
      provider: runContext.provider,
      providerContext: runContext.installationId
        ? { installationId: runContext.installationId }
        : {},
      sourceTarUrl: job.sourceTarUrl,
      sourceTarHash: job.sourceTarHash,
      depsUrl: job.depsUrl,
      depsHash: job.depsHash,
      // Include pre-resolved clone token for workers without provider credentials
      cloneToken: runContext.cloneToken,
    };
  }

  /**
   * Sort peers by available capacity for the given label sets.
   * Peers with more available capacity come first.
   */
  private sortPeersByCapacity(peers: PeerInfo[], labelSets: string[][]): PeerInfo[] {
    return [...peers].sort((a, b) => {
      const capacityA = this.computeAvailableCapacity(a, labelSets);
      const capacityB = this.computeAvailableCapacity(b, labelSets);
      return capacityB - capacityA; // Descending: most capacity first
    });
  }

  /**
   * Compute total available capacity across matching agents on a peer.
   *
   * Applies the same `mandatoryLabels` gate the local label matcher
   * applies — a gated agent only contributes capacity for label sets that
   * include every gate label. Without it, the coordinator would route a
   * job to a peer based on a gated agent's labels, and the peer would
   * then refuse the dispatch in `AgentRegistry.findAvailable` because the
   * agent's gate is not satisfied.
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
   * Track a rerouted job for cancel propagation, arm the post-ACK spawn-window
   * backstop timer, and durably tag the projected `execution_jobs` row with the
   * owning worker peer so run-recovery sweepers do not force-fail the job while
   * its worker is connected.
   */
  private async trackReroutedJob(
    runContext: RunContext,
    job: JobToRoute,
    labelSets: string[][],
    jobId: string,
    peerId: string,
    triedConnections: string[],
  ): Promise<void> {
    const runId = runContext.runId;
    let runJobs = this.reroutedJobs.get(runId);
    if (!runJobs) {
      runJobs = new Map();
      this.reroutedJobs.set(runId, runJobs);
    }

    // Arm the spawn-window backstop: if the peer accepted the reroute but never
    // reports progress within the window (async spawn failure, peer crash), the
    // timer fires handleRerouteSpawnTimeout to re-dispatch instead of stranding
    // the run until the ~20-min stale detector. Cleared on the first progress
    // (onPeerJobProgress) or on terminal cleanup.
    const window = await this.getRerouteSpawnWindowMs(job);
    const windowTimer = setTimeout(() => {
      void this.handleRerouteSpawnTimeout(runId, jobId).catch((err) => {
        logger.error('Reroute spawn-window handler failed', {
          runId,
          jobId,
          error: toErrorMessage(err),
        });
      });
    }, window);

    runJobs.set(jobId, {
      peerId,
      jobName: job.jobName,
      runContext,
      job,
      labelSets,
      triedConnections: [...triedConnections],
      windowTimer,
    });

    if (this.executionTracker) {
      // Seed the coordinator's in-memory job name at reroute time. The rerouted
      // job never enters the tracker's run.jobs (it is excluded from
      // addJobsToRun) and the coordinator owns no dispatch_queue row for the
      // worker's fresh jobId, so without this the step-log path resolver would
      // fall back to the bare jobId for the job's early relayed chunks and lose
      // them under an unreadable path.
      this.executionTracker.registerJobName(runId, jobId, job.jobName);
      await this.executionTracker.markJobReroutedToPeer(runId, jobId, peerId);
    }
  }

  /**
   * Post-ACK spawn-window backstop. Fires when a rerouted job's peer accepted
   * but produced no progress within the window (Layer A), or immediately when a
   * worker relays a `scaler.failed` for the job (Layer B, via onPeerScalerEvent).
   * Best-effort cancels the original peer (double-execution guard against a
   * slow-but-healthy spawn), then re-runs routing to another peer, then a local
   * fallback, and finally records the job failed rather than leaving it pending.
   * Idempotent: whichever trigger fires first removes the tracking entry, so the
   * other no-ops.
   */
  private async handleRerouteSpawnTimeout(runId: string, jobId: string): Promise<void> {
    const runJobs = this.reroutedJobs.get(runId);
    const tracked = runJobs?.get(jobId);
    if (!runJobs || !tracked) return; // Progress arrived / already re-dispatched.

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

    // Double-execution guard: best-effort cancel the original peer's job so a
    // slow-but-healthy spawn cannot run alongside the re-dispatch.
    this.cancelPeerJob(tracked.peerId, runId, jobId, 'reroute spawn window elapsed');

    // Re-run routing with the failed peer appended so it is never re-selected.
    const nextTried = [...tracked.triedConnections, tracked.peerId];
    const result = await this.attemptPeerRoute(
      tracked.runContext,
      tracked.job,
      tracked.labelSets,
      jobId,
      nextTried,
    );
    if (result.success) return;

    // No peer accepted → try a local dispatch (the coordinator may itself have
    // capacity now), keeping the same jobId so the execution row is reused.
    const localOk = await this.tryLocalRedispatch(tracked.runContext, tracked.job, jobId);
    if (localOk) return;

    // Unroutable everywhere → fail the job instead of leaving it pending until
    // the stale detector.
    await this.failUnroutableJob(runId, jobId, tracked.jobName);
  }

  /** Best-effort cancel a single job on a peer (double-execution guard). */
  private cancelPeerJob(peerId: string, runId: string, jobId: string, reason: string): void {
    const cancelMsg: PeerJobCancel = { type: 'peer.job.cancel', runId, jobId, reason };
    const client = this.getPeerClient(peerId);
    const sent = client
      ? client.send(cancelMsg)
      : (this.sendToPeerViaHandler?.(peerId, cancelMsg as PeerToPeerMessage) ?? false);
    if (!sent) {
      logger.warn('Failed to send re-dispatch cancel to peer', { peerId, runId, jobId });
    }
  }

  /**
   * Local fallback for a re-dispatch: dispatch the job on this coordinator under
   * the existing jobId. Returns true when the local dispatcher accepts it.
   */
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
      sourceTarHash: job.sourceTarHash,
      depsUrl: job.depsUrl,
      depsHash: job.depsHash,
      requestId: runContext.requestId,
      ...(job.resources && { resources: job.resources }),
    };
    const result = await this.dispatcher.dispatch(jobInput);
    if (result.status === 'duplicate') {
      // Row already present (idempotent no-op) — the job is queued/dispatched
      // under this jobId already. Treat as a successful local re-dispatch.
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
 * Per-agent mandatory-labels gate (Kubernetes-taint-style). Returns `true`
 * when every label in `agent.mandatoryLabels` appears in `requiredLabels`.
 * Empty `mandatoryLabels` is a no-op (returns `true`).
 *
 * Mirrors `peerAgentMatchesRequiredLabels` in `peer-registry.ts` —
 * coordinator-side capacity scoring must apply the same gate cluster
 * routing uses, otherwise the coordinator would over-count gated agents
 * when ranking peers for an off-gate label set.
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
