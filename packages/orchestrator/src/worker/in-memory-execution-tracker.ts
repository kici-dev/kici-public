/**
 * Execution tracker for DB-less worker nodes. It implements the subset the
 * dispatcher and processor call (onExecutionStarted, onJobStatus, onStepStatus,
 * getRunStatus), so they run unchanged on workers. It can forward status updates
 * to the coordinator, and keeps a ring buffer of recently completed jobs for /status.
 */

import type { ObserverRegistry } from '../ws/observer-registry.js';
import { TERMINAL_JOB_STATES } from '@kici-dev/engine';

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
  /** Forwards status updates to the coordinator over P2P. */
  onStatusForward?: (update: StatusUpdate) => void;
  /** Default: 50. */
  recentJobsLimit?: number;
  /** Broadcasts to CLI observers. */
  observerRegistry?: ObserverRegistry;
}

interface JobState {
  name: string;
  status: string;
  startedAt?: number;
  completedAt?: number;
}

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

  /** Positional signature matches ExecutionTracker.onExecutionStarted. */
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
   * Forget a job this worker gave up or was told to stop before it ran. Nothing is
   * forwarded: the coordinator that owns the run already decided what happens to it.
   */
  dropJob(runId: string, jobId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.jobs.delete(jobId);
    if (run.jobs.size === 0) this.runs.delete(runId);
  }

  getRunStatus(runId: string): RunState | null {
    return this.runs.get(runId) ?? null;
  }

  /** Most recent first. */
  getRecentJobs(): CompletedJobInfo[] {
    return [...this.recentJobs].reverse();
  }

  private addToRecentJobs(info: CompletedJobInfo): void {
    this.recentJobs.push(info);
    if (this.recentJobs.length > this.recentJobsLimit) {
      this.recentJobs.shift();
    }
  }
}
