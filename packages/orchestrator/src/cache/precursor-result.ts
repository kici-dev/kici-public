/**
 * Settling a pending precursor job — build, init, dynamic eval, global eval
 * round — from a terminal `job.status`, whichever channel delivered it.
 *
 * Two channels feed the pending trackers:
 *
 * - **The local agent socket.** The agent that ran the job reports to the
 *   coordinator it is connected to, and `app.ts` hands the frame here.
 * - **The shared database.** The dispatch queue is cluster-wide, so a job this
 *   coordinator dispatched may be claimed by an agent connected to a sibling
 *   coordinator. That sibling's frame never reaches this process; the sibling
 *   persists it to `execution_jobs` instead, and `PendingPrecursorDbWatcher`
 *   reads the row back and hands it here in the same shape.
 *
 * One function settles both so the two channels cannot drift on what counts as
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
 * The part of a precursor job's terminal `job.status.data` that the awaiting
 * coordinator needs, persisted to `execution_jobs.precursor_result` so a
 * sibling coordinator can read it back.
 *
 * Only the markers and their payloads are kept. The build marker is a flag —
 * the build's artifacts live in the shared source and dependency caches, keyed
 * by content hash, so the waiter re-reads them from there. The init and
 * dynamic-eval markers carry their results, because nothing else does.
 */
export interface PrecursorResult {
  buildComplete?: true;
  initComplete?: true;
  initResult?: InitResult;
  dynamicComplete?: true;
  dynamicJobs?: LockJob[];
}

/**
 * Pull the precursor payload out of a terminal `job.status.data`, or `null`
 * when the frame carries no precursor marker (an ordinary job).
 */
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
 * Every terminal state other than `success` rejects the waiter. An agent only
 * ever reports `failed` or `cancelled`, but the shared row also carries the
 * orchestrator-side verdicts — `timed_out_stale`, `unroutable`, … — written by
 * a sweep on whichever coordinator reaped the job, and a waiter on another
 * coordinator must not sit out its own timeout on a job the fleet already
 * gave up on.
 */
const isFailure = (state: string): boolean =>
  TERMINAL_JOB_STATES.has(state) && state !== ExecutionJobStatus.enum.success;

/**
 * Resolve or reject whichever tracker awaits `jobId`, from a terminal status.
 *
 * Returns true when an entry settled. A status for a job nobody awaits, or a
 * non-terminal status, settles nothing and returns false — the caller may log
 * that, but must not treat it as an error: the local channel sees every job's
 * frames, precursor or not.
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
      // Parse, never cast: `data` is an unvalidated record, so a cast here
      // would hand arbitrary agent-supplied JSON to a consumer that
      // dereferences it. A malformed result fails the round rather than the
      // process.
      const parsed = parseGlobalEvalResult(data.globalEvalResult);
      if (parsed.ok) {
        pendingGlobalEvals.resolve(jobId, parsed.value);
      } else {
        pendingGlobalEvals.reject(jobId, new Error(parsed.error));
      }
      settled = true;
    } else if (state === ExecutionJobStatus.enum.success) {
      // A success carrying no `globalEvalComplete` marker settles nothing on
      // its own, and the round job has no later terminal state to arrive — so
      // the waiter would hang until its wait ceiling fires. Reject on the spot
      // instead: the agent finished and told us nothing we can act on.
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
