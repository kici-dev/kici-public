/**
 * Leader-only orphan run cleanup.
 *
 * Periodically scans for execution runs stuck in 'running' state whose
 * coordinator orchestrator has crashed. Only the Raft leader runs recovery
 * to prevent multiple orchestrators from racing to recover the same run.
 *
 * Recovery logic:
 * 1. Find runs with status='running' and stale last update (> threshold)
 * 2. Check if the coordinator is still a connected peer
 * 3. If coordinator is disconnected/unknown, this is an orphan run
 * 4. Check job statuses: terminal jobs stay, stuck jobs get marked failed
 * 5. Finalize the run with computed overall status
 */

import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { ExecutionJobStatus, ExecutionRunStatus, TERMINAL_JOB_STATES } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { RaftNode } from './raft.js';
import type { PeerRegistry } from './peer-registry.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import { shouldDeferReroutedJob } from './rerouted-job-guard.js';
import type { ClusterSettingsReader } from './cluster-settings-reader.js';

const logger = createLogger({ prefix: 'orphan-recovery' });

/** How long a run must be stale before considered potentially orphaned (ms). */
const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/** How long a stuck job must have no heartbeat before marking as failed (ms). */
const DEFAULT_JOB_STUCK_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

interface OrphanRecoveryDeps {
  db: Kysely<Database>;
  raft: RaftNode;
  peerRegistry: PeerRegistry;
  executionTracker: ExecutionTracker;
  /** Reader for fleet-wide cluster tunables (reroute flap-grace override). */
  clusterSettings: ClusterSettingsReader;
  /** Cluster default for the reroute flap-grace window (config.rerouteFlapGraceMs). */
  rerouteFlapGraceFallbackMs: number;
  /** Scan interval in ms. Default: 60000 (1 minute). */
  scanIntervalMs?: number;
  /** How long a run must be stale before considered orphaned. Default: 5 minutes. */
  staleThresholdMs?: number;
  /** How long a stuck job must have no heartbeat before marking as failed. Default: 3 minutes. */
  jobStuckThresholdMs?: number;
}

export class OrphanRecovery {
  private readonly db: Kysely<Database>;
  private readonly raft: RaftNode;
  private readonly peerRegistry: PeerRegistry;
  private readonly executionTracker: ExecutionTracker;
  private readonly clusterSettings: ClusterSettingsReader;
  private readonly rerouteFlapGraceFallbackMs: number;
  private readonly scanIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly jobStuckThresholdMs: number;
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: OrphanRecoveryDeps) {
    this.db = deps.db;
    this.raft = deps.raft;
    this.peerRegistry = deps.peerRegistry;
    this.executionTracker = deps.executionTracker;
    this.clusterSettings = deps.clusterSettings;
    this.rerouteFlapGraceFallbackMs = deps.rerouteFlapGraceFallbackMs;
    this.scanIntervalMs = deps.scanIntervalMs ?? 60_000;
    this.staleThresholdMs = deps.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    this.jobStuckThresholdMs = deps.jobStuckThresholdMs ?? DEFAULT_JOB_STUCK_THRESHOLD_MS;
  }

  /**
   * Start periodic orphan recovery scans.
   * Only runs recovery logic when this node is the Raft leader.
   */
  start(): void {
    if (this.scanTimer) return;

    this.scanTimer = setInterval(() => {
      this.scanForOrphans().catch((err) => {
        logger.error('Orphan recovery scan failed', {
          error: toErrorMessage(err),
        });
      });
    }, this.scanIntervalMs);

    logger.info('Orphan recovery started', {
      scanIntervalMs: this.scanIntervalMs,
      staleThresholdMs: this.staleThresholdMs,
    });
  }

  /**
   * Stop periodic orphan recovery scans.
   */
  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    logger.info('Orphan recovery stopped');
  }

  /**
   * Scan for orphaned runs and recover them.
   * Only runs when this node is the Raft leader.
   */
  async scanForOrphans(): Promise<void> {
    // Guard: only leader runs recovery
    if (!this.raft.isLeader()) {
      return;
    }

    // Find runs stuck in 'running' with stale update timestamps
    const staleThreshold = new Date(Date.now() - this.staleThresholdMs);

    const staleRuns = await this.db
      .selectFrom('execution_runs')
      .select(['run_id', 'routing_key', 'workflow_name', 'provider', 'repo_identifier', 'sha'])
      .where('status', '=', ExecutionRunStatus.enum.running)
      .where('started_at', '<', staleThreshold)
      .execute();

    if (staleRuns.length === 0) {
      return;
    }

    logger.info('Found potentially orphaned runs', {
      count: staleRuns.length,
    });

    for (const run of staleRuns) {
      await this.recoverRun(run);
    }
  }

  /**
   * Attempt to recover a single potentially orphaned run.
   */
  private async recoverRun(run: {
    run_id: string;
    routing_key: string | null;
    workflow_name: string;
    provider: string;
    repo_identifier: string;
    sha: string;
  }): Promise<void> {
    // Check if the coordinator orchestrator is still connected.
    // We use the routing key to identify the coordinator. If any peer
    // shares the same routing key and is connected, the run may not be orphaned.
    const isCoordinatorConnected = this.isCoordinatorStillConnected(run.routing_key);

    if (isCoordinatorConnected) {
      // Coordinator still alive -- not orphaned, skip
      return;
    }

    // A run that is still making progress is NOT orphaned, whatever the peer
    // registry says. The candidate query selects on `started_at`, so any run
    // simply LONGER than the stale threshold lands here, and the peer check
    // above can never vouch for a single-node orchestrator (it has no peers).
    // Without this guard, a healthy long run on a single-node deployment is
    // force-failed by its own coordinator.
    if (await this.hasRecentProgress(run.run_id)) {
      logger.debug('Skipping orphan recovery: run is still making progress', {
        runId: run.run_id,
      });
      return;
    }

    logger.info('Recovering orphan run', {
      runId: run.run_id,
      routingKey: run.routing_key,
      workflowName: run.workflow_name,
    });

    // Get all jobs for this run
    const jobs = await this.db
      .selectFrom('execution_jobs')
      .select(['job_id', 'job_name', 'status', 'last_heartbeat_at', 'rerouted_to_peer'])
      .where('run_id', '=', run.run_id)
      .execute();

    if (jobs.length === 0) {
      // No jobs recorded -- mark run as failed directly
      await this.db
        .updateTable('execution_runs')
        .set({
          status: ExecutionRunStatus.enum.failed,
          completed_at: new Date(),
          failure_reason: 'No jobs found for orphaned run',
        })
        .where('run_id', '=', run.run_id)
        .where('status', '=', ExecutionRunStatus.enum.running)
        .execute();

      logger.info('Finalized orphan run with no jobs', {
        runId: run.run_id,
      });

      // Notify Platform of terminal status via completeRunIfAllJobsTerminal's DB-fallback path.
      // With 0 jobs, the method will see the run is already terminal and skip,
      // so we also need to forward the status explicitly.
      this.executionTracker.emitInfraEvent(run.run_id, 'orchestrator.run.orphan_recovered', {
        metadata: { routingKey: run.routing_key, reason: 'No jobs found' },
      });
      return;
    }

    // Check each job's status
    const jobStuckThreshold = new Date(Date.now() - this.jobStuckThresholdMs);
    for (const job of jobs) {
      if (TERMINAL_JOB_STATES.has(job.status)) {
        // Job already terminal, nothing to do
        continue;
      }

      // Job is non-terminal (running/pending). If it was rerouted to a worker
      // peer that is connected — or was seen within the flap-grace window of a
      // transient reconnect — defer the force-fail: the worker's terminal
      // status may still be replayed from its durable outbox.
      const flapGraceMs = await this.clusterSettings.getNumber(
        'reroute_flap_grace_ms',
        this.rerouteFlapGraceFallbackMs,
      );
      if (shouldDeferReroutedJob(job, this.peerRegistry, { flapGraceMs })) {
        logger.info(
          'Deferring orphan-fail for rerouted job; worker peer connected or recently seen',
          {
            runId: run.run_id,
            jobId: job.job_id,
            peer: job.rerouted_to_peer,
          },
        );
        continue;
      }

      // Check if heartbeat is stale
      const lastHeartbeat = job.last_heartbeat_at ? new Date(job.last_heartbeat_at) : new Date(0);

      if (lastHeartbeat < jobStuckThreshold) {
        // Job is stuck -- mark as failed

        await this.db
          .updateTable('execution_jobs')
          .set({
            status: ExecutionJobStatus.enum.failed,
            error_message: 'Orphan recovery: coordinator crashed, job stuck with no heartbeat',
            completed_at: new Date(),
          })
          .where('run_id', '=', run.run_id)
          .where('job_id', '=', job.job_id)
          .where('status', '=', job.status)
          .execute();

        // Update in-memory tracker if available
        this.executionTracker.updateInMemoryJob(
          run.run_id,
          job.job_id,
          ExecutionJobStatus.enum.failed,
        );

        const errorMsg = 'Orphan recovery: coordinator crashed, job stuck with no heartbeat';

        // Forward terminal status to Platform
        this.executionTracker.forwardJobTerminalStatus(
          run.run_id,
          job.job_id,
          job.job_name,
          ExecutionJobStatus.enum.failed,
          errorMsg,
        );

        // Cancel any in-progress steps so dashboard doesn't show stale running indicators
        await this.executionTracker.cancelStepsForJob(run.run_id, job.job_id, errorMsg);

        // Emit infrastructure event for dashboard timeline
        this.executionTracker.emitInfraEvent(run.run_id, 'orchestrator.job.orphan_recovered', {
          jobId: job.job_id,
          metadata: { jobName: job.job_name, reason: errorMsg },
        });

        logger.info('Marked stuck job as failed', {
          runId: run.run_id,
          jobId: job.job_id,
          jobName: job.job_name,
        });
      }
      // If heartbeat is recent, the job might still be running on an agent
      // connected to a different orchestrator -- leave it alone for now
    }

    // Emit infrastructure event for dashboard timeline before finalizing
    this.executionTracker.emitInfraEvent(run.run_id, 'orchestrator.run.orphan_recovered', {
      metadata: { routingKey: run.routing_key, workflowName: run.workflow_name },
    });

    // Check if all jobs are now terminal and finalize the run.
    // This method handles DB update, Platform notification, commit status updates,
    // and workflow completion callbacks — same path used by StaleRunDetector.
    await this.executionTracker.completeRunIfAllJobsTerminal(run.run_id);
  }

  /**
   * Whether any job of the run moved within the stale window — a heartbeat, a
   * start, or a completion. A crashed coordinator stops producing all three, so
   * a genuinely orphaned run becomes eligible again within one window; a healthy
   * long run never does.
   */
  private async hasRecentProgress(runId: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - this.staleThresholdMs);
    const row = await this.db
      .selectFrom('execution_jobs')
      .select((eb) => [
        eb.fn.max('last_heartbeat_at').as('last_heartbeat_at'),
        eb.fn.max('completed_at').as('completed_at'),
        eb.fn.max('started_at').as('started_at'),
      ])
      .where('run_id', '=', runId)
      .executeTakeFirst();
    if (!row) return false;
    const stamps = [row.last_heartbeat_at, row.completed_at, row.started_at];
    return stamps.some((t) => t != null && new Date(t) >= cutoff);
  }

  /**
   * Check if a coordinator with the given routing key is still connected
   * as a peer in the cluster.
   */
  private isCoordinatorStillConnected(routingKey: string | null): boolean {
    if (!routingKey) return false;

    const connectedPeers = this.peerRegistry.getConnectedPeers();
    return connectedPeers.some((peer) => peer.routingKeys.includes(routingKey));
  }
}
