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
import { TERMINAL_JOB_STATES } from '@kici-dev/engine';
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

  /**
   * Tracks which jobs have been rerouted to which peers, keyed by runId.
   * Used for cancel propagation and progress tracking.
   */
  private readonly reroutedJobs = new Map<
    string,
    Map<string, { peerId: string; jobName: string }>
  >();

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
      if (owner && repo) {
        try {
          await this.checkRunReporter.setPendingAwait({
            provider: msg.provider ?? '',
            owner,
            repo,
            sha: msg.sha,
            workflowName: msg.workflowName,
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
  onPeerJobProgress(msg: JobProgress, reply?: (m: JobProgressAck) => void): void {
    if (this.executionTracker) {
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
          const tracked = this.reroutedJobs.get(msg.runId)?.get(msg.jobId);
          if (tracked && this.executionTracker && !TERMINAL_JOB_STATES.has(msg.state)) {
            await this.executionTracker.markJobReroutedToPeer(msg.runId, msg.jobId, tracked.peerId);
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
    // residual set. The previous code path waited for an unwired
    // `peer.job.complete` message that never arrived.
    if (msg.kind === 'job' && TERMINAL_JOB_STATES.has(msg.state)) {
      const runJobs = this.reroutedJobs.get(msg.runId);
      if (runJobs) {
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
   */
  onPeerScalerEvent(msg: PeerScalerEvent): void {
    this.executionTracker?.emitScalerEvent(msg.runId, msg.jobId, {
      agentId: msg.agentId,
      eventType: msg.eventType,
      detail: msg.detail,
      timestampMs: msg.timestampMs,
    });
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

    // Clean up rerouted job tracking
    const runJobs = this.reroutedJobs.get(runId);
    if (runJobs) {
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

    // Group jobs by peer for efficient messaging
    const peerJobs = new Map<string, string[]>();
    for (const [jobId, info] of runJobs) {
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
   * Attempt to reroute a job to a peer with matching capacity.
   * Tries peers in order of available capacity (most capacity first).
   * Returns on first successful ACK.
   */
  private async rerouteJob(
    runContext: RunContext,
    job: JobToRoute,
    labelSets: string[][],
  ): Promise<{ success: boolean; peerId?: string; jobId?: string; reason?: string }> {
    const peers = this.peerRegistry.findPeersWithCapacity(labelSets);

    if (peers.length === 0) {
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
        return {
          success: false,
          reason: `Peers with matching labels exist but are at capacity`,
        };
      }
      return {
        success: false,
        reason: `No orchestrator in cluster handles labels: ${labelSets.map((ls) => ls.join(',')).join(' | ')}`,
      };
    }

    // Sort by available capacity (most capacity first)
    const sortedPeers = this.sortPeersByCapacity(peers, labelSets);

    const now = Date.now();

    for (const peer of sortedPeers) {
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

      // Pre-allocate the jobId on the sender side so we can register the
      // execution_runs + execution_jobs rows before the worker reports
      // back. Without this, the worker generates its own jobId and the
      // first peer.job.progress arriving at this coord finds no matching
      // run+job row (recoverRunFromDb returns null) and is silently
      // dropped — leaving the run stalled at `running` forever.
      const allocatedJobId = randomUUID();
      const rerouteMsg: JobReroute = {
        type: 'job.reroute',
        messageId: randomUUID(),
        jobId: allocatedJobId,
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
        triedConnections: [this.instanceId],
        maxHops: DEFAULT_MAX_HOPS,
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

      const accepted = client
        ? await client.sendAndWaitAck(rerouteMsg, this.ackTimeoutMs)
        : await this.sendAndWaitAckViaHandler!(peer.instanceId, rerouteMsg, this.ackTimeoutMs);

      if (accepted) {
        // ACK: reset NAK tracking for this peer
        this.nakTracker.delete(peer.instanceId);

        // Track rerouted job under the *allocated* jobId (not the wire
        // messageId) so cancel propagation and the onPeerJobProgress
        // residual-cleanup path see the same key the worker reports back.
        // This records the in-memory reroute mapping; the durable
        // `rerouted_to_peer` marker is (re)asserted in onPeerJobProgress once
        // the worker's first status creates the execution_jobs row (the row
        // does not exist yet at reroute-ACK time, so a marker write here would
        // be a no-op UPDATE).
        await this.trackReroutedJob(runContext.runId, allocatedJobId, peer.instanceId, job.jobName);

        logger.info('Job rerouted to peer', {
          runId: runContext.runId,
          jobName: job.jobName,
          jobId: allocatedJobId,
          peerId: peer.instanceId,
        });

        return { success: true, peerId: peer.instanceId, jobId: allocatedJobId };
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
   * Track a rerouted job for cancel propagation, and durably tag the projected
   * `execution_jobs` row with the owning worker peer so run-recovery sweepers
   * do not force-fail the job while its worker is connected.
   */
  private async trackReroutedJob(
    runId: string,
    jobId: string,
    peerId: string,
    jobName: string,
  ): Promise<void> {
    let runJobs = this.reroutedJobs.get(runId);
    if (!runJobs) {
      runJobs = new Map();
      this.reroutedJobs.set(runId, runJobs);
    }
    runJobs.set(jobId, { peerId, jobName });

    if (this.executionTracker) {
      await this.executionTracker.markJobReroutedToPeer(runId, jobId, peerId);
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
