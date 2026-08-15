import { ExecutionJobStatus, TERMINAL_JOB_STATES, type TerminalJobStatus } from '@kici-dev/engine';
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { buildJobFailureDescription, type CheckRunReporter } from './check-run-reporter.js';
import type { ExecutionContext } from './execution-tracker.js';

const logger = createLogger({ prefix: 'check-run-completion' });

/**
 * Job-terminal signal this module reacts to. Shaped after the payload the
 * execution tracker hands its `onJobComplete` hook — its primary caller — plus
 * the agent-supplied `data` blob used to build the enriched check-run summary.
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
   * Explicit check-run description, overriding the conclusion mapper's default
   * wording. A caller that already holds the specific reason a job ended the way
   * it did passes it here — the queue-expiry sweep's `unroutable` message, for
   * instance, is the only statement of WHICH `runsOn` selectors went unmatched,
   * and the mapper's generic phrasing cannot name them.
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
 * Narrow a raw status string to the terminal subset.
 *
 * Keyed on the canonical `TERMINAL_JOB_STATES` set rather than a second
 * hand-written status list: a status added to the engine enum joins the set (and
 * widens `TerminalJobStatus`) automatically, so nothing here has to be
 * remembered and updated a second time.
 */
function isTerminalJobStatus(status: string): status is TerminalJobStatus {
  return TERMINAL_JOB_STATES.has(status);
}

/**
 * Post the terminal conclusion for a job's check run.
 *
 * Every job that reaches a terminal state must resolve the check run that
 * `setPending()` created for it at trigger match. A check run left `queued` is
 * not cosmetic: branch protection that requires it can never be satisfied, and
 * a developer reads it as "still running" indefinitely with nothing to point at.
 *
 * A non-terminal status is a no-op — a check run is completed once, when the job
 * stops.
 *
 * Never throws. Its callers are hot paths whose remaining work matters more than
 * this report: the tracker's terminal-job hook runs inside `onJobStatus`, ahead
 * of the job-complete event emission and the needs/wave scheduler hooks, and the
 * expiry sweep runs it per job inside a loop. `buildJobFailureDescription` reads
 * an agent-supplied payload, so a malformed `stepResults` entry is enough to
 * raise — and a check-run report is not worth stalling a run's scheduling for.
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

  // An explicit description wins; otherwise build a meaningful one from agent
  // data on failure, and let every other terminal status take the mapper's own
  // wording.
  const description =
    input.description ??
    (input.status === ExecutionJobStatus.enum.failed && input.data
      ? buildJobFailureDescription(input.data)
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
    // Pass additional data for enriched summaries
    data: input.data,
    runIdForLogs: input.runId,
    jobId: input.jobId,
    // Explicit runId — this fires from the tracker's terminal-job hook, which
    // runs outside the request-context ALS frame that wrapped the original
    // dispatch, so the reporter cannot pull runId from getRequestContext().
    // Without it, the completion update omits details_url and GitHub falls back
    // to the App's homepage URL.
    runId: input.runId,
  });
}
