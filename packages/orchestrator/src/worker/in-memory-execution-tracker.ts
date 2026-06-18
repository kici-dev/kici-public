/**
 * In-memory execution tracker for worker nodes.
 *
 * Workers have no database access. This lightweight implementation
 * satisfies the same interface subset that the dispatcher and processor
 * call (onExecutionStarted, onJobStatus, onStepStatus, getRunStatus),
 * allowing those subsystems to work unchanged on workers.
 *
 * Optionally forwards status updates via a callback for coordinator relay,
 * and maintains a ring buffer of recently completed jobs for /status.
 */

import type { ObserverRegistry } from '../ws/observer-registry.js';
import { TERMINAL_JOB_STATES } from '@kici-dev/engine';

/** Default number of recent completed jobs to retain. */
const DEFAULT_RECENT_JOBS_LIMIT = 50;

/** A status update forwarded to the coordinator. */
export interface StatusUpdate {
  type: 'job' | 'step';
  runId: string;
  jobId: string;
  status: string;
  stepIndex?: number;
  stepName?: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

/** A completed job entry in the ring buffer. */
interface CompletedJobInfo {
  runId: string;
  jobId: string;
  jobName: string;
  status: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

interface InMemoryExecutionTrackerOptions {
  /** Callback to forward status updates to coordinator via P2P. */
  onStatusForward?: (update: StatusUpdate) => void;
  /** Maximum number of recent completed jobs to keep. Default: 50. */
  recentJobsLimit?: number;
  /** Optional observer registry for broadcasting to CLI observers. */
  observerRegistry?: ObserverRegistry;
}

/** In-memory state for a single job within a run. */
interface JobState {
  name: string;
  status: string;
  startedAt?: number;
  completedAt?: number;
}

/** In-memory state for a single execution run. */
interface RunState {
  workflowName: string;
  provider: string;
  repoIdentifier: string;
  sha: string;
  ref: string;
  startedAt: number;
  jobs: Map<string, JobState>;
}

export class InMemoryExecutionTracker {
  private readonly onStatusForward?: (update: StatusUpdate) => void;
  private readonly recentJobsLimit: number;
  private readonly observerRegistry?: ObserverRegistry;
  private readonly runs = new Map<string, RunState>();
  private readonly recentJobs: CompletedJobInfo[] = [];

  constructor(options: InMemoryExecutionTrackerOptions) {
    this.onStatusForward = options.onStatusForward;
    this.recentJobsLimit = options.recentJobsLimit ?? DEFAULT_RECENT_JOBS_LIMIT;
    this.observerRegistry = options.observerRegistry;
  }

  /**
   * Record a new execution run with its initial jobs.
   * Signature matches ExecutionTracker.onExecutionStarted (positional args).
   */
  async onExecutionStarted(
    runId: string,
    workflowName: string,
    provider: string,
    repoIdentifier: string,
    ref: string,
    sha: string,
    _deliveryId: string | null,
    _providerContext: Record<string, unknown>,
    _triggerDecision: Record<string, unknown> | null,
    jobs: Array<{ jobId: string; jobName: string; matrixValues?: Record<string, unknown> }>,
  ): Promise<void> {
    const jobMap = new Map<string, JobState>();
    for (const job of jobs) {
      jobMap.set(job.jobId, { name: job.jobName, status: 'pending' });
    }

    this.runs.set(runId, {
      workflowName,
      provider,
      repoIdentifier,
      sha,
      ref,
      startedAt: Date.now(),
      jobs: jobMap,
    });
  }

  /**
   * Update job status. Forwards to coordinator callback if configured.
   */
  async onJobStatus(
    runId: string,
    jobId: string,
    status: string,
    timestamp: number,
    agentId?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    const job = run.jobs.get(jobId);
    if (!job) return;

    job.status = status;

    // Track timing
    if (status === 'running' && !job.startedAt) {
      job.startedAt = timestamp;
    }
    if (TERMINAL_JOB_STATES.has(status)) {
      job.completedAt = timestamp;
      this.addToRecentJobs({
        runId,
        jobId,
        jobName: job.name,
        status,
        startedAt: job.startedAt ?? timestamp,
        completedAt: timestamp,
        durationMs: timestamp - (job.startedAt ?? timestamp),
      });

      // Clean up the run from memory once all its jobs are terminal
      const allTerminal = [...run.jobs.values()].every((j) => TERMINAL_JOB_STATES.has(j.status));
      if (allTerminal) {
        this.runs.delete(runId);
      }
    }

    this.onStatusForward?.({
      type: 'job',
      runId,
      jobId,
      status,
      timestamp,
      data,
    });
  }

  /**
   * Update step status. Forwards to coordinator callback if configured.
   */
  async onStepStatus(
    runId: string,
    jobId: string,
    stepIndex: number,
    stepName: string,
    status: string,
    timestamp: number,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;

    this.onStatusForward?.({
      type: 'step',
      runId,
      jobId,
      status,
      stepIndex,
      stepName,
      timestamp,
      data,
    });
  }

  /**
   * Get the current status of a run.
   */
  getRunStatus(runId: string): RunState | null {
    return this.runs.get(runId) ?? null;
  }

  /**
   * Get recent completed jobs (most recent first).
   */
  getRecentJobs(): CompletedJobInfo[] {
    return [...this.recentJobs].reverse();
  }

  // ── Internal ──────────────────────────────────────────────────────

  private addToRecentJobs(info: CompletedJobInfo): void {
    this.recentJobs.push(info);
    if (this.recentJobs.length > this.recentJobsLimit) {
      this.recentJobs.shift();
    }
  }
}
