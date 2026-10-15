/**
 * Leader-only orphan run cleanup.
 *
 * Periodically scans for execution runs stuck in 'running' state whose
 * coordinator orchestrator has crashed. Only the Raft leader runs recovery
 * to prevent multiple orchestrators from racing to recover the same run.
 *
 * Recovery logic:
 * 1. Find runs with status='running' that started before the stale threshold
 * 2. Check if the coordinator is still a connected peer
 * 3. If coordinator is disconnected/unknown, this is an orphan run
 * 4. Check job statuses: terminal jobs stay, stuck jobs get marked failed
 * 5. Finalize the run with computed overall status
 */

import type { Kysely } from 'kysely';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  TERMINAL_JOB_STATES,
  TERMINAL_RUN_STATES,
} from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import type { RaftNode } from './raft.js';
import type { PeerRegistry } from './peer-registry.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import { shouldDeferReroutedJob } from './rerouted-job-guard.js';
import type { ClusterSettingsReader } from './cluster-settings-reader.js';
import { ConcurrencySlotStatus } from '../concurrency/queue-manager.js';

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
  /** Source of the reroute flap-grace override. */
  clusterSettings: ClusterSettingsReader;
  /** Cluster default for the reroute flap-grace window (config.rerouteFlapGraceMs). */
  rerouteFlapGraceFallbackMs: number;
  /** Scan interval in ms. Default: 60000 (1 minute). */
  scanIntervalMs?: number;
  /** Default: 5 minutes. */
  staleThresholdMs?: number;
  /** Default: 3 minutes. */
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

  /** Recovery logic runs only while this node is the Raft leader. */
  start(): void {
    if (this.scanTimer) return;

    this.releaseLeakedConcurrencySlots().catch((err) => {
      logger.error('Concurrency slot reconcile failed', { error: toErrorMessage(err) });
    });

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

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    logger.info('Orphan recovery stopped');
  }

  async scanForOrphans(): Promise<void> {
    if (!this.raft.isLeader()) {
      return;
    }

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
   * Release concurrency slots still marked `active` for a run that has already
   * finished. Run once per leader transition (`start()`), which covers a boot
   * and a failover.
   *
   * A coordinator crash between "the run finished" and "the slot was released"
   * leaks the slot; on a `max: 1` deploy gate it blocks every later deploy
   * forever, and nothing else notices. `getActiveRuns` reconciles the same way
   * on every acquire, so this only sweeps scopes nobody asks about — hence once
   * per leader transition is enough.
   */
  async releaseLeakedConcurrencySlots(): Promise<void> {
    const leaked = await this.db
      .selectFrom('concurrency_groups as cg')
      .innerJoin('execution_runs as er', 'er.run_id', 'cg.run_id')
      .select(['cg.id'])
      .where('cg.status', '=', ConcurrencySlotStatus.Active)
      .where('er.status', 'in', [...TERMINAL_RUN_STATES])
      .execute();
    if (leaked.length === 0) return;

    await this.db
      .updateTable('concurrency_groups')
      .set({ status: ConcurrencySlotStatus.Completed, completed_at: new Date() })
      .where(
        'id',
        'in',
        leaked.map((r) => r.id),
      )
      .execute();
    logger.info('Released concurrency slots held by finished runs', { released: leaked.length });
  }

  private async recoverRun(run: {
    run_id: string;
    routing_key: string | null;
    workflow_name: string;
    provider: string;
    repo_identifier: string;
    sha: string;
  }): Promise<void> {
    // The routing key identifies the coordinator: a connected peer sharing it
    // means the run may not be orphaned.
    const isCoordinatorConnected = this.isCoordinatorStillConnected(run.routing_key);

    if (isCoordinatorConnected) {
      return;
    }

    // A run still making progress is not orphaned, whatever the peer registry
    // says. The candidate query selects on `started_at`, so every run longer than
    // the threshold lands here, and the peer check never vouches for a
    // single-node orchestrator: without this guard its own coordinator
    // force-fails a healthy long run.
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

    const jobs = await this.db
      .selectFrom('execution_jobs')
      .select(['job_id', 'job_name', 'status', 'last_heartbeat_at', 'rerouted_to_peer'])
      .where('run_id', '=', run.run_id)
      .execute();

    if (jobs.length === 0) {
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

      // No terminal status is forwarded from here: the infra event records the
      // recovery, and the Platform's run-mirror reconciler re-pulls a mirror row
      // that is still non-terminal.
      this.executionTracker.emitInfraEvent(run.run_id, 'orchestrator.run.orphan_recovered', {
        metadata: { routingKey: run.routing_key, reason: 'No jobs found' },
      });
      return;
    }

    const jobStuckThreshold = new Date(Date.now() - this.jobStuckThresholdMs);
    for (const job of jobs) {
      if (TERMINAL_JOB_STATES.has(job.status)) {
        continue;
      }

      // A job rerouted to a worker peer that is connected, or seen within the
      // flap-grace window, is deferred: the worker may still replay its terminal
      // status from its durable outbox.
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

      const lastHeartbeat = job.last_heartbeat_at ? new Date(job.last_heartbeat_at) : new Date(0);

      if (lastHeartbeat < jobStuckThreshold) {
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

        this.executionTracker.updateInMemoryJob(
          run.run_id,
          job.job_id,
          ExecutionJobStatus.enum.failed,
        );

        const errorMsg = 'Orphan recovery: coordinator crashed, job stuck with no heartbeat';

        this.executionTracker.forwardJobTerminalStatus(
          run.run_id,
          job.job_id,
          job.job_name,
          ExecutionJobStatus.enum.failed,
          errorMsg,
        );

        // So the dashboard shows no stale running steps.
        await this.executionTracker.cancelStepsForJob(run.run_id, job.job_id, errorMsg);

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
      // A recent heartbeat means the job may still run on an agent connected to
      // another orchestrator, so it is left alone.
    }

    this.executionTracker.emitInfraEvent(run.run_id, 'orchestrator.run.orphan_recovered', {
      metadata: { routingKey: run.routing_key, workflowName: run.workflow_name },
    });

    // Finalizes the run (DB, Platform, commit status, completion callbacks) on the
    // same path StaleRunDetector uses.
    await this.executionTracker.completeRunIfAllJobsTerminal(run.run_id);
  }

  /**
   * Whether any job had a heartbeat, start or completion within the stale
   * window. A crashed coordinator stops all three, so an orphaned run becomes
   * eligible within one window; a healthy long run never does.
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

  private isCoordinatorStillConnected(routingKey: string | null): boolean {
    if (!routingKey) return false;

    const connectedPeers = this.peerRegistry.getConnectedPeers();
    return connectedPeers.some((peer) => peer.routingKeys.includes(routingKey));
  }
}
