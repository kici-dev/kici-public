/**
 * Notes `kici runs show` and `kici runs logs` print on standard error when a
 * run's step detail is missing. Standard output and the exit code stay the
 * same, so a script that reads either is unaffected.
 */
import pc from 'picocolors';
import {
  ExecutionJobStatus,
  JobKind,
  RunDetailFallbackReason,
  RunDetailSource,
  TERMINAL_JOB_STATES,
  type DashboardJobDetail,
} from '@kici-dev/engine';
import type { RunDetailRead } from '../../remote/dashboard-client.js';

/** The reason, as the note says it. */
const FALLBACK_REASON_TEXT: Record<RunDetailFallbackReason, string> = {
  [RunDetailFallbackReason.enum.orchestrator_unreachable]:
    'no orchestrator that can serve this run is connected',
  [RunDetailFallbackReason.enum.orchestrator_timeout]: 'the orchestrator did not respond in time',
  [RunDetailFallbackReason.enum.orchestrator_error]: 'the orchestrator returned an error',
  [RunDetailFallbackReason.enum.invalid_response]: 'the orchestrator response was not valid',
  [RunDetailFallbackReason.enum.no_jobs]: 'the orchestrator reported no jobs',
};

/**
 * Whether the job started on an agent, and so could have written a setup log.
 * A job that never started (queued, skipped, cancelled first) or that runs on
 * no agent (an invoke gate, a summoned-run proxy) has none to report on.
 */
export function ranOnAnAgent(job: DashboardJobDetail): boolean {
  return job.startedAt !== null && (job.jobKind ?? JobKind.enum.standard) === JobKind.enum.standard;
}

/**
 * The notes for a run's detail: none when every finished job has its steps. A
 * skipped job ran no step, so it has none to miss: its rules returned `false`
 * on the agent before the first step started.
 */
export function stepDetailNotes(read: RunDetailRead): string[] {
  if (read.source === RunDetailSource.enum['platform-db']) {
    const reason = read.fallbackReason
      ? FALLBACK_REASON_TEXT[read.fallbackReason]
      : 'the Platform did not name a reason';
    return [
      `step detail unavailable: the Platform could not read it from the orchestrator that ran this run (${reason})`,
    ];
  }
  return read.detail.jobs
    .filter(
      (job) =>
        ranOnAnAgent(job) &&
        TERMINAL_JOB_STATES.has(job.status) &&
        job.status !== ExecutionJobStatus.enum.skipped &&
        (job.steps ?? []).length === 0,
    )
    .map(
      (job) =>
        `no step detail for job ${job.jobName}: it ran on an agent, but the orchestrator reported no steps`,
    );
}

/** Print each note on standard error once, however many times it comes back. */
export function printNotes(notes: Iterable<string>, printed: Set<string>): void {
  for (const note of notes) {
    if (printed.has(note)) continue;
    printed.add(note);
    console.error(pc.yellow(note));
  }
}
