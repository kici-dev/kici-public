/**
 * StaleRunDetector: periodic DB scanner for stale execution jobs.
 *
 * Detects jobs that have stopped sending heartbeats (agent died, network partition,
 * container killed, etc.) and marks them as timed_out_stale. Also detects stale
 * dispatch_queue entries that were dispatched but never acknowledged.
 *
 * Key behaviors:
 * - Immediate startup scan for crash recovery (finds stale jobs from before restart)
 * - Periodic scans at configurable interval (default 60s)
 * - Uses timed_out_stale as distinct DB status (not just 'failed')
 * - Optimistic concurrency: WHERE status='running' prevents race with agent completion
 * - Does NOT call executionTracker.onJobStatus() to avoid redundant DB writes
 * - Updates in-memory state and calls completeRunIfAllJobsTerminal for run completion
 * - Force-terminates stale agents via scaler manager
 * - Updates GitHub check runs with timed_out conclusion
 */

import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { CheckRunReporter } from '../reporting/check-run-reporter.js';
import type { ScalerManager } from '../scaler/manager.js';
import type { Dispatcher } from '../agent/dispatcher.js';
import type { AgentRegistry } from '../agent/registry.js';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { ExecutionJobStatus } from '@kici-dev/engine';
import {
  staleRunsDetectedTotal,
  staleDetectionDurationSeconds,
  setStaleRunsCurrent,
} from '../metrics/prometheus.js';
import type { HeldRunStore, ReleaseSignal } from '../environments/held-runs.js';
import type { StepApprovalBridge } from '../approvals/step-approval-bridge.js';
import type { AccessLogWriter } from '../audit/access-log.js';
import { DispatchQueueStatus } from '../queue/job-queue.js';

const logger = createLogger({ prefix: 'stale-detector' });

export interface StaleRunDetectorDeps {
  db: Kysely<Database>;
  executionTracker: ExecutionTracker;
  checkRunReporter?: CheckRunReporter;
  scalerManager?: ScalerManager;
  dispatcher: Dispatcher;
  registry: AgentRegistry;
  /** Threshold in ms after which a job is considered stale. Default: heartbeatIntervalMs * multiplier */
  staleThresholdMs: number;
  /** How often to scan for stale jobs in ms. Default: 60_000 */
  scanIntervalMs: number;
  /** Held run store for expiring overdue held runs. Optional -- if not set, held run cleanup is skipped. */
  heldRunStore?: HeldRunStore;
  /** Step-approval bridge — notified when a step-scoped hold expires so the waiting agent fails the step. Optional. */
  stepApprovalBridge?: StepApprovalBridge;
  /** Fail a whole run when a job/workflow-scoped approval hold expires. Optional. */
  failRun?: (runId: string, reason: string) => Promise<void>;
  /**
   * Resume a workflow whose install-gate wait-timer hold has elapsed. Wired to
   * the same `resumeWorkflow` path as reviewer approvals. Optional -- if not
   * set, wait-timer workflow holds are not auto-released.
   */
  onWorkflowRelease?: (signal: ReleaseSignal) => Promise<void>;
  /** Access-log writer for the orchestrator audit stream. Optional -- if not set, expiry audit rows (`held_run.expire`) are skipped. */
  accessLogWriter?: AccessLogWriter;
}

export class StaleRunDetector {
  private readonly db: Kysely<Database>;
  private readonly executionTracker: ExecutionTracker;
  private readonly checkRunReporter?: CheckRunReporter;
  private readonly scalerManager?: ScalerManager;
  private readonly dispatcher: Dispatcher;
  private readonly registry: AgentRegistry;
  private readonly staleThresholdMs: number;
  private readonly scanIntervalMs: number;
  private readonly heldRunStore?: HeldRunStore;
  private readonly stepApprovalBridge?: StepApprovalBridge;
  private readonly failRun?: (runId: string, reason: string) => Promise<void>;
  private readonly onWorkflowRelease?: (signal: ReleaseSignal) => Promise<void>;
  private readonly accessLogWriter?: AccessLogWriter;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: StaleRunDetectorDeps) {
    this.db = deps.db;
    this.executionTracker = deps.executionTracker;
    this.checkRunReporter = deps.checkRunReporter;
    this.scalerManager = deps.scalerManager;
    this.dispatcher = deps.dispatcher;
    this.registry = deps.registry;
    this.staleThresholdMs = deps.staleThresholdMs;
    this.scanIntervalMs = deps.scanIntervalMs;
    this.heldRunStore = deps.heldRunStore;
    this.stepApprovalBridge = deps.stepApprovalBridge;
    this.failRun = deps.failRun;
    this.onWorkflowRelease = deps.onWorkflowRelease;
    this.accessLogWriter = deps.accessLogWriter;
  }

  /**
   * Release workflow install-gate wait-timer holds whose timer has elapsed.
   * Runs BEFORE `expireOverdueHolds` so a wait hold resumes the workflow rather
   * than being failed by the expire-and-fail sweep.
   */
  private async releaseDueWaitHolds(): Promise<void> {
    if (!this.heldRunStore || !this.onWorkflowRelease) return;
    try {
      const released = await this.heldRunStore.releaseDueWaitHolds();
      for (const signal of released) {
        try {
          await this.onWorkflowRelease(signal);
        } catch (err) {
          logger.error('Error resuming workflow after wait-timer release', {
            runId: signal.runId,
            error: toErrorMessage(err),
          });
        }
      }
      if (released.length > 0) {
        logger.info('Released workflow wait-timer install holds', { count: released.length });
      }
    } catch (err) {
      logger.error('Error releasing due wait holds', { error: toErrorMessage(err) });
    }
  }

  /**
   * Expire overdue approval holds. Routes each overdue hold by scope BEFORE the
   * bulk status flip: step-scoped holds notify the waiting agent (which fails
   * the step), job/workflow-scoped holds fail the whole run. Then the bulk
   * `expireOverdue()` flips every overdue row to `expired`.
   */
  private async expireOverdueHolds(): Promise<void> {
    if (!this.heldRunStore) return;
    try {
      const overdue = await this.heldRunStore.listOverdue();
      for (const hold of overdue) {
        try {
          if (hold.hold_scope === 'step') {
            this.stepApprovalBridge?.resolve(hold.id, 'expired');
          } else if (this.failRun) {
            await this.failRun(hold.run_id, `Approval expired for ${hold.hold_scope} hold`);
          }
          // Audit the expiry. The stale detector expires the hold automatically
          // (no human / Keycloak user context), so the actor is the stale-detector
          // system component.
          void this.accessLogWriter?.record({
            orgId: hold.org_id,
            routingKey: null,
            actor: { type: 'system', component: 'stale-detector' },
            action: 'held_run.expire',
            target: { type: 'held_run', id: hold.id },
            requestId: null,
            source: 'platform_proxy',
            outcome: 'allowed',
            meta: {
              runId: hold.run_id,
              jobId: hold.job_id,
              holdScope: hold.hold_scope,
            },
          });
        } catch (err) {
          logger.error('Error routing expired hold', {
            holdId: hold.id,
            error: toErrorMessage(err),
          });
        }
      }
      const expiredCount = await this.heldRunStore.expireOverdue();
      if (expiredCount > 0) {
        logger.info('Expired overdue held runs', { expiredCount });
      }
    } catch (err) {
      logger.error('Error expiring held runs', { error: toErrorMessage(err) });
    }
  }

  /**
   * Clean up orphaned jobs left in 'recovering' state from a previous orchestrator instance.
   *
   * Recovery timers are in-memory (Dispatcher) and lost on restart. Any jobs still
   * in 'recovering' state after a restart have no timer and no path to completion,
   * so they must be failed immediately.
   *
   * Call this during startup, before the first periodic scan.
   */
  async cleanupOrphanedRecoveryJobs(): Promise<void> {
    // Find affected run IDs before updating so we can check run completion afterward
    const affectedJobs = await this.db
      .selectFrom('execution_jobs')
      .select(['run_id'])
      .where('status', '=', ExecutionJobStatus.enum.recovering)
      .execute();

    if (affectedJobs.length === 0) return;

    // Fail execution_jobs in 'recovering' state
    await this.db
      .updateTable('execution_jobs')
      .set({
        status: ExecutionJobStatus.enum.failed,
        error_message: 'Job failed: orchestrator restarted during recovery (recovery state lost)',
        completed_at: new Date(),
      })
      .where('status', '=', ExecutionJobStatus.enum.recovering)
      .execute();

    // Also fail corresponding dispatch_queue entries
    await this.db
      .updateTable('dispatch_queue')
      .set({ status: DispatchQueueStatus.Failed })
      .where('status', '=', DispatchQueueStatus.Recovering)
      .execute();

    logger.warn('Cleaned up orphaned recovering jobs from previous instance', {
      count: affectedJobs.length,
    });

    // Check run completion for all affected runs — without this, runs whose
    // only remaining active jobs were in 'recovering' state would be stuck
    // in 'running' status forever (scan() only checks running/dispatched jobs).
    const affectedRunIds = new Set(affectedJobs.map((j) => j.run_id));
    for (const runId of affectedRunIds) {
      try {
        await this.executionTracker.completeRunIfAllJobsTerminal(runId);
      } catch (err) {
        logger.error('Error checking run completion after orphaned recovery cleanup', {
          runId,
          error: toErrorMessage(err),
        });
      }
    }
  }

  /**
   * Start the stale run detector.
   * Runs an immediate scan for crash recovery, then starts periodic scans.
   */
  async start(): Promise<void> {
    // Immediate scan for crash recovery
    await this.scan();

    // Start periodic scanning
    this.interval = setInterval(() => {
      this.scan().catch((err) => {
        logger.error('Stale detection scan error (interval)', {
          error: toErrorMessage(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      });
    }, this.scanIntervalMs);
  }

  /**
   * Stop the stale run detector.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Run a single stale detection scan.
   *
   * Three sub-scans:
   * A. Running jobs with old heartbeat (last_heartbeat_at < threshold)
   * B. Running jobs with NULL heartbeat (created_at < threshold, pre-heartbeat jobs)
   * C. Dispatched queue entries that were never acknowledged
   *
   * After all sub-scans, checks run completion for affected runs.
   *
   * Note: jobs in 'recovering' state are NOT scanned -- they have their own
   * per-job recovery timers managed by the Dispatcher (see Phase 15).
   * All sub-scans filter on status='running' or status='dispatched',
   * so recovering jobs are naturally excluded.
   */
  async scan(): Promise<void> {
    try {
      const threshold = new Date(Date.now() - this.staleThresholdMs);
      // Time-bound: only scan jobs created in the last 24 hours to prevent scanning ancient history
      const timeBound = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const affectedRunIds = new Set<string>();
      let staleCount = 0;

      // Sub-scan A: Running jobs with old heartbeat
      staleCount += await this.scanStaleRunningJobs(threshold, timeBound, affectedRunIds);

      // Sub-scan B: Running jobs with NULL heartbeat (fallback to created_at)
      staleCount += await this.scanStaleRunningJobsNullHeartbeat(
        threshold,
        timeBound,
        affectedRunIds,
      );

      // Sub-scan C: Dispatched queue entries that were never acknowledged
      staleCount += await this.scanStaleDispatchedJobs(threshold, timeBound, affectedRunIds);

      // Sub-scan E: Expire overdue held runs (after releasing wait-timer holds
      // so a wait-timer workflow hold resumes instead of being failed).
      if (this.heldRunStore) {
        await this.releaseDueWaitHolds();
        await this.expireOverdueHolds();
      }

      // Update gauge with total stale jobs found this scan
      setStaleRunsCurrent(staleCount);

      // Sub-scan D: Run completion check for all affected runs
      for (const runId of affectedRunIds) {
        try {
          await this.executionTracker.completeRunIfAllJobsTerminal(runId);
        } catch (err) {
          logger.error('Error checking run completion after stale detection', {
            runId,
            error: toErrorMessage(err),
          });
        }
      }

      if (staleCount > 0) {
        logger.info('Stale detection scan complete', {
          staleJobsFound: staleCount,
          affectedRuns: affectedRunIds.size,
        });
      }
    } catch (err) {
      logger.error('Stale detection scan error', {
        error: toErrorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  }

  /**
   * Sub-scan A: Find running jobs with stale heartbeats.
   */
  private async scanStaleRunningJobs(
    threshold: Date,
    timeBound: Date,
    affectedRunIds: Set<string>,
  ): Promise<number> {
    const staleJobs = await this.db
      .selectFrom('execution_jobs as ej')
      .innerJoin('execution_runs as er', 'er.run_id', 'ej.run_id')
      .select([
        'ej.run_id',
        'ej.job_id',
        'ej.job_name',
        'ej.agent_id',
        'ej.last_heartbeat_at',
        'er.workflow_name',
        'er.repo_identifier',
        'er.sha',
        'er.provider',
        'er.provider_context',
        'er.routing_key',
      ])
      .where('ej.status', '=', ExecutionJobStatus.enum.running)
      .where('ej.last_heartbeat_at', 'is not', null)
      .where('ej.last_heartbeat_at', '<', threshold)
      .where('ej.created_at', '>', timeBound)
      .execute();

    let markedCount = 0;
    for (const job of staleJobs) {
      const marked = await this.markJobStale(job, affectedRunIds);
      if (marked) markedCount++;
    }

    return markedCount;
  }

  /**
   * Sub-scan B: Find running jobs with NULL heartbeat and old created_at.
   * These are jobs that started before the heartbeat system existed or where
   * the initial heartbeat was never set.
   */
  private async scanStaleRunningJobsNullHeartbeat(
    threshold: Date,
    timeBound: Date,
    affectedRunIds: Set<string>,
  ): Promise<number> {
    const staleJobs = await this.db
      .selectFrom('execution_jobs as ej')
      .innerJoin('execution_runs as er', 'er.run_id', 'ej.run_id')
      .select([
        'ej.run_id',
        'ej.job_id',
        'ej.job_name',
        'ej.agent_id',
        'ej.last_heartbeat_at',
        'ej.created_at',
        'er.workflow_name',
        'er.repo_identifier',
        'er.sha',
        'er.provider',
        'er.provider_context',
        'er.routing_key',
      ])
      .where('ej.status', '=', ExecutionJobStatus.enum.running)
      .where('ej.last_heartbeat_at', 'is', null)
      .where('ej.created_at', '<', threshold)
      .where('ej.created_at', '>', timeBound)
      .execute();

    let markedCount = 0;
    for (const job of staleJobs) {
      const marked = await this.markJobStale(job, affectedRunIds);
      if (marked) markedCount++;
    }

    return markedCount;
  }

  /**
   * Sub-scan C: Find dispatched entries that were never acknowledged.
   *
   * Only catches dispatches that the agent never started — i.e., the
   * dispatch_queue row is still 'dispatched' AND there is no
   * execution_jobs row in 'running' state. When the agent has reported
   * the job as running (so execution_jobs.status='running'), heartbeat
   * supervision falls to sub-scans A and B, which look at
   * `execution_jobs.last_heartbeat_at`. Without this filter, a long
   * job whose first step legitimately exceeds the dispatch threshold
   * (e.g. an inline `npm install` for a workflow that imports
   * `@kici-dev/sdk`) would be marked stale here before sub-scan A's
   * heartbeat path has a chance to keep it alive.
   *
   * 'queued' jobs are legitimately waiting for agents and handled by
   * the queue timeout in {@link JobQueue.markExpired} instead.
   */
  private async scanStaleDispatchedJobs(
    threshold: Date,
    timeBound: Date,
    affectedRunIds: Set<string>,
  ): Promise<number> {
    const staleEntries = await this.db
      .selectFrom('dispatch_queue as dq')
      .innerJoin('execution_runs as er', (join) =>
        join.onRef('er.run_id', '=', sql`dq.run_id::uuid`),
      )
      .leftJoin('execution_jobs as ej', (join) =>
        join.onRef('ej.run_id', '=', sql`dq.run_id::uuid`).onRef('ej.job_name', '=', 'dq.job_name'),
      )
      .select([
        'dq.id',
        'dq.run_id',
        'dq.job_name',
        'dq.status',
        'er.workflow_name',
        'er.repo_identifier',
        'er.sha',
        'er.provider',
        'er.provider_context',
        'er.routing_key',
      ])
      .where('dq.status', '=', DispatchQueueStatus.Dispatched)
      .where('dq.created_at', '<', threshold)
      .where('dq.created_at', '>', timeBound)
      // Skip rows where the agent has already started running the job —
      // those are supervised by the heartbeat scanners (sub-scans A + B).
      .where((eb) =>
        eb.or([
          eb('ej.status', 'is', null),
          eb('ej.status', '!=', ExecutionJobStatus.enum.running),
        ]),
      )
      .execute();

    let markedCount = 0;
    for (const entry of staleEntries) {
      // Mark dispatch_queue as failed
      const dqResult = await this.db
        .updateTable('dispatch_queue')
        .set({ status: DispatchQueueStatus.Failed })
        .where('id', '=', sql<string>`${entry.id}::uuid`)
        .where('status', '=', DispatchQueueStatus.Dispatched)
        .executeTakeFirst();

      if (!dqResult.numUpdatedRows || dqResult.numUpdatedRows === 0n) {
        continue; // Already handled by another process
      }

      // Also mark the corresponding execution_jobs row as timed_out_stale
      const errorMessage = 'No heartbeat -- dispatch never acknowledged';
      const ejResult = await this.db
        .updateTable('execution_jobs')
        .set({
          status: ExecutionJobStatus.enum.timed_out_stale,
          completed_at: new Date(),
          error_message: errorMessage,
        })
        .where('run_id', '=', sql<string>`${entry.run_id}::uuid`)
        .where('job_name', '=', entry.job_name)
        .where('status', 'in', [
          ExecutionJobStatus.enum.pending,
          ExecutionJobStatus.enum.queued,
          ExecutionJobStatus.enum.running,
        ])
        .executeTakeFirst();

      if (ejResult.numUpdatedRows && ejResult.numUpdatedRows > 0n) {
        // Find the jobId for in-memory state update
        const ejRow = await this.db
          .selectFrom('execution_jobs')
          .select(['job_id'])
          .where('run_id', '=', sql<string>`${entry.run_id}::uuid`)
          .where('job_name', '=', entry.job_name)
          .executeTakeFirst();

        if (ejRow) {
          this.executionTracker.updateInMemoryJob(
            entry.run_id,
            ejRow.job_id,
            ExecutionJobStatus.enum.timed_out_stale,
          );

          // Forward terminal status to Platform
          this.executionTracker.forwardJobTerminalStatus(
            entry.run_id,
            ejRow.job_id,
            entry.job_name,
            ExecutionJobStatus.enum.timed_out_stale,
            errorMessage,
          );

          // Emit infrastructure event for dashboard timeline
          this.executionTracker.emitInfraEvent(entry.run_id, 'orchestrator.job.stale_detected', {
            jobId: ejRow.job_id,
            metadata: {
              jobName: entry.job_name,
              reason: errorMessage,
            },
          });
        }

        affectedRunIds.add(entry.run_id);

        logger.warn('Stale dispatched job detected', {
          runId: entry.run_id,
          jobName: entry.job_name,
          dispatchQueueId: entry.id,
          previousStatus: entry.status,
        });

        markedCount++;
        staleRunsDetectedTotal.add(1);

        // Update GitHub check run with timed_out conclusion
        if (this.checkRunReporter) {
          const [owner, repo] = entry.repo_identifier.split('/');
          const providerCtx =
            typeof entry.provider_context === 'string'
              ? JSON.parse(entry.provider_context)
              : (entry.provider_context ?? {});
          const installationId =
            typeof providerCtx.installationId === 'number' ? providerCtx.installationId : undefined;

          this.checkRunReporter.updateJobStatus({
            provider: entry.provider,
            owner,
            repo,
            sha: entry.sha,
            workflowName: entry.workflow_name,
            jobName: entry.job_name,
            state: ExecutionJobStatus.enum.timed_out_stale,
            description: errorMessage,
            installationId,
            routingKey: entry.routing_key ?? undefined,
            // Explicit runId — the stale-detector tick fires from a
            // setInterval outside any request-context ALS frame, so the
            // reporter's fallback can't find the runId. Without this,
            // buildDetailsUrl() returns undefined and GitHub defaults
            // details_url to the App's homepage URL.
            runId: entry.run_id,
          });
        }
      }
    }

    return markedCount;
  }

  /**
   * Mark a single running job as timed_out_stale.
   * Shared by sub-scans A and B.
   */
  private async markJobStale(
    job: {
      run_id: string;
      job_id: string;
      job_name: string;
      agent_id: string | null;
      last_heartbeat_at: Date | null;
      workflow_name: string;
      repo_identifier: string;
      sha: string;
      provider: string;
      provider_context: string;
      routing_key: string | null;
    },
    affectedRunIds: Set<string>,
  ): Promise<boolean> {
    const now = new Date();
    const staleDurationMs = job.last_heartbeat_at
      ? now.getTime() - new Date(job.last_heartbeat_at).getTime()
      : undefined;
    const errorMessage = staleDurationMs
      ? `No heartbeat received for ${Math.round(staleDurationMs / 1000)}s`
      : 'No heartbeat received (heartbeat was never set)';

    // Optimistic update: only update if still running
    const result = await this.db
      .updateTable('execution_jobs')
      .set({
        status: ExecutionJobStatus.enum.timed_out_stale,
        completed_at: now,
        error_message: errorMessage,
      })
      .where('run_id', '=', job.run_id)
      .where('job_id', '=', job.job_id)
      .where('status', '=', ExecutionJobStatus.enum.running)
      .executeTakeFirst();

    if (!result.numUpdatedRows || result.numUpdatedRows === 0n) {
      return false; // Job already completed (race with agent)
    }

    logger.warn('Stale running job detected', {
      runId: job.run_id,
      jobId: job.job_id,
      jobName: job.job_name,
      workflowName: job.workflow_name,
      repoIdentifier: job.repo_identifier,
      agentId: job.agent_id,
      lastHeartbeatAt: job.last_heartbeat_at?.toISOString(),
      staleDurationMs,
    });

    // Increment metrics
    staleRunsDetectedTotal.add(1);
    if (staleDurationMs !== undefined) {
      staleDetectionDurationSeconds.record(staleDurationMs / 1000);
    }

    // Update in-memory state (no redundant DB write via onJobStatus)
    this.executionTracker.updateInMemoryJob(
      job.run_id,
      job.job_id,
      ExecutionJobStatus.enum.timed_out_stale,
    );

    // Forward terminal status to Platform so its execution_jobs projection stays in sync
    this.executionTracker.forwardJobTerminalStatus(
      job.run_id,
      job.job_id,
      job.job_name,
      ExecutionJobStatus.enum.timed_out_stale,
      errorMessage,
    );

    // Emit infrastructure event for dashboard timeline
    this.executionTracker.emitInfraEvent(job.run_id, 'orchestrator.job.stale_detected', {
      jobId: job.job_id,
      metadata: {
        jobName: job.job_name,
        agentId: job.agent_id,
        staleDurationMs,
        lastHeartbeatAt: job.last_heartbeat_at?.toISOString(),
        reason: errorMessage,
      },
    });

    // Cancel any in-progress steps so dashboard doesn't show stale running indicators
    await this.executionTracker.cancelStepsForJob(job.run_id, job.job_id, errorMessage);

    // Collect affected runId for batch run completion check
    affectedRunIds.add(job.run_id);

    // Update GitHub check run with timed_out conclusion
    if (this.checkRunReporter) {
      const [owner, repo] = job.repo_identifier.split('/');
      const providerCtx =
        typeof job.provider_context === 'string'
          ? JSON.parse(job.provider_context)
          : (job.provider_context ?? {});
      const installationId =
        typeof providerCtx.installationId === 'number' ? providerCtx.installationId : undefined;

      this.checkRunReporter.updateJobStatus({
        provider: job.provider,
        owner,
        repo,
        sha: job.sha,
        workflowName: job.workflow_name,
        jobName: job.job_name,
        state: ExecutionJobStatus.enum.timed_out_stale,
        description: errorMessage,
        installationId,
        routingKey: job.routing_key ?? undefined,
        runId: job.run_id,
      });
    }

    // Force-terminate stale agent
    if (job.agent_id) {
      if (this.scalerManager) {
        this.scalerManager.onAgentDisconnected(job.agent_id);
      }
      if (this.registry.get(job.agent_id)) {
        await this.dispatcher.onAgentDisconnect(job.agent_id);
      }
    }

    return true;
  }
}
