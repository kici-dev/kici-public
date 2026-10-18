import { ExecutionJobStatus, TERMINAL_JOB_STATES, type TerminalJobStatus } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { buildJobFailureDescription, type CheckRunReporter } from './check-run-reporter.js';
import type { ExecutionContext } from './execution-tracker.js';

const logger = createLogger({ prefix: 'check-run-completion' });

/**
 * Shaped after the payload the execution tracker (the primary caller) hands its
 * `onJobComplete` hook, plus the agent-supplied `data` blob for the enriched summary.
 */
export interface JobCheckRunCompletionInput {
  runId: string;
  jobId: string;
  jobName: string;
  /** Raw job status string as recorded by the tracker. */
  status: string;
  /** Agent-supplied job payload (step results, error, duration). */
  data?: Record<string, unknown>;
  /**
   * Overrides the conclusion mapper's default wording with a reason the caller already
   * holds — e.g. the queue-expiry sweep's `unroutable` message is the only statement of
   * WHICH `runsOn` selectors went unmatched, which the mapper's phrasing cannot name.
   */
  description?: string;
}

/** Collaborators needed to post a job's terminal check-run conclusion. */
export interface JobCheckRunCompletionDeps {
  checkRunReporter: Pick<CheckRunReporter, 'updateJobStatus'>;
  /** Resolves the run's provider/repo/sha context — `ExecutionTracker.getExecutionContext`. */
  getExecutionContext: (runId: string) => ExecutionContext | undefined;
}

/**
 * Keyed on the canonical `TERMINAL_JOB_STATES` set rather than a hand-written list, so a
 * status added to the engine enum joins the set (and widens `TerminalJobStatus`)
 * automatically.
 */
function isTerminalJobStatus(status: string): status is TerminalJobStatus {
  return TERMINAL_JOB_STATES.has(status);
}

/**
 * Every terminal job must resolve the check run `setPending()` created at trigger match.
 * A check run left `queued` is not cosmetic: branch protection requiring it can never be
 * satisfied, and a developer reads it as "still running" indefinitely.
 *
 * A non-terminal status is a no-op — a check run is completed once, when the job stops.
 *
 * Never throws. Its callers are hot paths whose remaining work matters more: the
 * tracker's terminal-job hook runs inside `onJobStatus`, ahead of the job-complete event
 * and the needs/wave scheduler hooks, and the expiry sweep runs it per job in a loop.
 * `buildJobFailureDescription` reads an agent-supplied payload, so a malformed
 * `stepResults` entry can raise — not worth stalling a run's scheduling for.
 */
export function reportJobCheckRunCompletion(
  deps: JobCheckRunCompletionDeps,
  input: JobCheckRunCompletionInput,
): void {
  try {
    postJobCheckRunCompletion(deps, input);
  } catch (err) {
    logger.error('Failed to report job check-run completion', {
      error: toErrorMessage(err),
      runId: input.runId,
      jobId: input.jobId,
      status: input.status,
    });
  }
}

function postJobCheckRunCompletion(
  deps: JobCheckRunCompletionDeps,
  input: JobCheckRunCompletionInput,
): void {
  if (!isTerminalJobStatus(input.status)) return;

  const execContext = deps.getExecutionContext(input.runId);
  if (!execContext) {
    logger.debug('No execution context for job check-run completion, skipping', {
      runId: input.runId,
      jobId: input.jobId,
    });
    return;
  }

  const [owner, repo] = execContext.repoIdentifier.split('/');

  // Explicit wins; else build one from agent data on failure, or name a skip's reason;
  // else the mapper's wording.
  const skipReason = input.data?.error;
  const description =
    input.description ??
    (input.status === ExecutionJobStatus.enum.failed && input.data
      ? buildJobFailureDescription(input.data)
      : input.status === ExecutionJobStatus.enum.skipped &&
          typeof skipReason === 'string' &&
          skipReason !== ''
        ? `Job skipped: ${skipReason}`
        : undefined);

  deps.checkRunReporter.updateJobStatus({
    provider: execContext.provider,
    owner,
    repo,
    sha: execContext.sha,
    workflowName: execContext.workflowName,
    // Present only for a cross-repository global run — see `workflowLabel`.
    ...(execContext.workflowRepoIdentifier && {
      workflowRepoIdentifier: execContext.workflowRepoIdentifier,
    }),
    jobName: input.jobName,
    state: input.status,
    installationId: execContext.installationId,
    routingKey: execContext.routingKey,
    description,
    // Trust posture, so the summary can say why a job on an untrusted ref behaved
    // differently. Absent when trust never resolved.
    ...(execContext.trustTier !== undefined && { trustTier: execContext.trustTier }),
    ...(execContext.lockFileSource !== undefined && {
      lockFileSource: execContext.lockFileSource,
    }),
    data: input.data,
    runIdForLogs: input.runId,
    jobId: input.jobId,
    // Explicit: the terminal-job hook runs outside the dispatch's request-context ALS
    // frame, so getRequestContext() has no runId; without it the update omits
    // details_url and GitHub falls back to the App's homepage URL.
    runId: input.runId,
  });
}
