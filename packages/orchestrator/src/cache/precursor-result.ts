/**
 * Settles a pending precursor job (build, init, dynamic eval, global eval
 * round) from a terminal `job.status`, via either channel:
 *
 * - **The local agent socket:** `app.ts` hands the frame here.
 * - **The shared database:** the dispatch queue is cluster-wide, so an agent
 *   on a sibling coordinator may claim the job; the sibling persists the frame
 *   to `execution_jobs` and `PendingPrecursorDbWatcher` hands it here in the
 *   same shape.
 *
 * One function settles both so the channels cannot drift on what counts as
 * "the build finished" or "the init returned its result".
 */

import type { InitFailure, LockJob } from '@kici-dev/engine';
import { ExecutionJobStatus, TERMINAL_JOB_STATES } from '@kici-dev/engine';
import { AgentJobFailedError } from './agent-job-failed-error.js';
import type { PendingBuildTracker } from './pending-builds.js';
import type { PendingDynamicTracker } from './pending-dynamics.js';
import { parseGlobalEvalResult, type PendingGlobalEvalTracker } from './pending-global-evals.js';
import type { InitResult, PendingInitTracker } from './pending-inits.js';

/**
 * The part of a precursor's terminal `job.status.data` the awaiting coordinator
 * needs, persisted to `execution_jobs.precursor_result` for siblings. The build
 * marker is a flag (its output lives in the content-hashed source and
 * dependency caches); the init and dynamic-eval markers carry their results,
 * because nothing else does.
 */
export interface PrecursorResult {
  buildComplete?: true;
  initComplete?: true;
  initResult?: InitResult;
  dynamicComplete?: true;
  dynamicJobs?: LockJob[];
}

/** `null` when the frame carries no precursor marker (an ordinary job). */
export function extractPrecursorResult(
  data: Record<string, unknown> | undefined,
): PrecursorResult | null {
  if (!data) return null;
  const out: PrecursorResult = {};
  if (data.buildComplete === true) out.buildComplete = true;
  if (data.initComplete === true) {
    out.initComplete = true;
    if (data.initResult !== undefined) out.initResult = data.initResult as InitResult;
  }
  if (data.dynamicComplete === true) {
    out.dynamicComplete = true;
    out.dynamicJobs = Array.isArray(data.dynamicJobs) ? (data.dynamicJobs as LockJob[]) : [];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The settle-side surface of a tracker: membership plus the two ways to settle. */
type Settleable<T> = Pick<T, Extract<keyof T, 'has' | 'resolve' | 'reject'>>;

export interface PendingPrecursorTrackers {
  pendingBuilds?: Settleable<PendingBuildTracker>;
  pendingInits?: Settleable<PendingInitTracker>;
  pendingDynamics?: Settleable<PendingDynamicTracker>;
  pendingGlobalEvals?: Settleable<PendingGlobalEvalTracker>;
}

export interface PrecursorJobStatus {
  jobId: string;
  state: string;
  data?: Record<string, unknown>;
}

/**
 * Every terminal state but `success` rejects. Agents report only `failed` or
 * `cancelled`, but the shared row also carries sweep verdicts
 * (`timed_out_stale`, `unroutable`, …) from whichever coordinator reaped the
 * job, and a waiter elsewhere must not sit out its own timeout on them.
 */
const isFailure = (state: string): boolean =>
  TERMINAL_JOB_STATES.has(state) && state !== ExecutionJobStatus.enum.success;

/**
 * Resolve or reject whichever tracker awaits `jobId`; true when one settled.
 * False (an unawaited job, a non-terminal status) is not an error: the local
 * channel sees every job's frames, precursor or not.
 */
export function settlePendingPrecursor(
  trackers: PendingPrecursorTrackers,
  { jobId, state, data }: PrecursorJobStatus,
): boolean {
  const { pendingBuilds, pendingInits, pendingDynamics, pendingGlobalEvals } = trackers;
  let settled = false;

  if (pendingBuilds?.has(jobId)) {
    if (state === ExecutionJobStatus.enum.success && data?.buildComplete) {
      pendingBuilds.resolve(jobId);
      settled = true;
    } else if (isFailure(state)) {
      pendingBuilds.reject(jobId, new Error((data?.error as string) ?? `Build ${state}`));
      settled = true;
    }
  }

  if (pendingInits?.has(jobId)) {
    if (state === ExecutionJobStatus.enum.success && data?.initComplete) {
      pendingInits.resolve(jobId, ((data.initResult as InitResult) ?? {}) as InitResult);
      settled = true;
    } else if (isFailure(state)) {
      pendingInits.reject(
        jobId,
        new AgentJobFailedError(
          (data?.error as string) ?? `Init ${state}`,
          data?.initFailure as InitFailure | undefined,
        ),
      );
      settled = true;
    }
  }

  if (pendingDynamics?.has(jobId)) {
    if (state === ExecutionJobStatus.enum.success && data?.dynamicComplete) {
      pendingDynamics.resolve(jobId, (data.dynamicJobs as LockJob[]) ?? []);
      settled = true;
    } else if (isFailure(state)) {
      pendingDynamics.reject(
        jobId,
        new AgentJobFailedError(
          (data?.error as string) ?? `Dynamic eval ${state}`,
          data?.initFailure as InitFailure | undefined,
        ),
      );
      settled = true;
    }
  }

  if (pendingGlobalEvals?.has(jobId)) {
    if (state === ExecutionJobStatus.enum.success && data?.globalEvalComplete) {
      // Parse, never cast: `data` is unvalidated agent JSON that the consumer
      // dereferences. A malformed result fails the round, not the process.
      const parsed = parseGlobalEvalResult(data.globalEvalResult);
      if (parsed.ok) {
        pendingGlobalEvals.resolve(jobId, parsed.value);
      } else {
        pendingGlobalEvals.reject(jobId, new Error(parsed.error));
      }
      settled = true;
    } else if (state === ExecutionJobStatus.enum.success) {
      // A success without the `globalEvalComplete` marker has no later terminal
      // state to follow, so the waiter would hang until its wait ceiling.
      pendingGlobalEvals.reject(
        jobId,
        new Error('Global eval round reported success without a result payload'),
      );
      settled = true;
    } else if (isFailure(state)) {
      pendingGlobalEvals.reject(
        jobId,
        new AgentJobFailedError(
          (data?.error as string) ?? `Global eval round ${state}`,
          data?.initFailure as InitFailure | undefined,
        ),
      );
      settled = true;
    }
  }

  return settled;
}
