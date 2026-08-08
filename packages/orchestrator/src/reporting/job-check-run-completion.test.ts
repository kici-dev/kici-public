import { ExecutionJobStatus, TERMINAL_JOB_STATES } from '@kici-dev/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from './execution-tracker.js';
import { reportJobCheckRunCompletion } from './job-check-run-completion.js';

const execContext: ExecutionContext = {
  workflowName: 'ci',
  provider: 'github',
  repoIdentifier: 'acme/widgets',
  sha: 'deadbeef',
  installationId: 4242,
  routingKey: 'github:4242',
};

function makeDeps(context?: ExecutionContext | null) {
  const resolved = context === null ? undefined : (context ?? execContext);
  const updateJobStatus = vi.fn();
  return {
    updateJobStatus,
    deps: {
      checkRunReporter: { updateJobStatus },
      getExecutionContext: vi.fn(() => resolved),
    },
  };
}

describe('reportJobCheckRunCompletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes the check run for EVERY terminal job status', () => {
    // The defect this guards: a job that ends `skipped` or `drift_dropped`
    // used to leave its check run `queued` forever, so branch protection
    // requiring it could never be satisfied.
    //
    // The loop below is the whole assertion, so an empty (or shrunken) set
    // would make this test pass while proving nothing. Pin the floor at the
    // statuses that motivated the fix plus the three the agent reports.
    expect(TERMINAL_JOB_STATES.size).toBeGreaterThanOrEqual(5);
    expect([...TERMINAL_JOB_STATES]).toEqual(
      expect.arrayContaining([
        ExecutionJobStatus.enum.skipped,
        ExecutionJobStatus.enum.drift_dropped,
      ]),
    );

    for (const status of TERMINAL_JOB_STATES) {
      const { updateJobStatus, deps } = makeDeps();

      reportJobCheckRunCompletion(deps, {
        runId: 'run-1',
        jobId: 'job-1',
        jobName: 'build',
        status,
      });

      expect(
        updateJobStatus,
        `terminal status ${status} must complete its check run`,
      ).toHaveBeenCalledTimes(1);
      expect(updateJobStatus.mock.calls[0][0]).toMatchObject({
        provider: 'github',
        owner: 'acme',
        repo: 'widgets',
        sha: 'deadbeef',
        workflowName: 'ci',
        jobName: 'build',
        state: status,
        installationId: 4242,
        routingKey: 'github:4242',
        runId: 'run-1',
        jobId: 'job-1',
        runIdForLogs: 'run-1',
      });
    }
  });

  it('completes the check run for a skipped job', () => {
    const { updateJobStatus, deps } = makeDeps();

    reportJobCheckRunCompletion(deps, {
      runId: 'run-1',
      jobId: 'job-1',
      jobName: 'deploy',
      status: ExecutionJobStatus.enum.skipped,
    });

    expect(updateJobStatus).toHaveBeenCalledTimes(1);
    expect(updateJobStatus.mock.calls[0][0].state).toBe(ExecutionJobStatus.enum.skipped);
  });

  it('completes the check run for a drift-dropped job', () => {
    const { updateJobStatus, deps } = makeDeps();

    reportJobCheckRunCompletion(deps, {
      runId: 'run-1',
      jobId: 'job-1',
      jobName: 'deploy',
      status: ExecutionJobStatus.enum.drift_dropped,
    });

    expect(updateJobStatus).toHaveBeenCalledTimes(1);
    expect(updateJobStatus.mock.calls[0][0].state).toBe(ExecutionJobStatus.enum.drift_dropped);
  });

  it.each([
    ExecutionJobStatus.enum.pending,
    ExecutionJobStatus.enum.queued,
    ExecutionJobStatus.enum.running,
    ExecutionJobStatus.enum.recovering,
    ExecutionJobStatus.enum.cancelling,
  ])('is a no-op for the non-terminal status %s', (status) => {
    const { updateJobStatus, deps } = makeDeps();

    reportJobCheckRunCompletion(deps, {
      runId: 'run-1',
      jobId: 'job-1',
      jobName: 'build',
      status,
    });

    expect(updateJobStatus).not.toHaveBeenCalled();
  });

  it('builds a failure description from the agent payload on failure', () => {
    const { updateJobStatus, deps } = makeDeps();

    reportJobCheckRunCompletion(deps, {
      runId: 'run-1',
      jobId: 'job-1',
      jobName: 'build',
      status: ExecutionJobStatus.enum.failed,
      data: { error: 'step 2 exited 1' },
    });

    expect(updateJobStatus).toHaveBeenCalledTimes(1);
    const call = updateJobStatus.mock.calls[0][0];
    expect(call.description).toContain('step 2 exited 1');
    expect(call.data).toEqual({ error: 'step 2 exited 1' });
  });

  it('prefers an explicit description over the mapper wording and the payload', () => {
    // The queue-expiry sweep holds the only text naming which `runsOn`
    // selectors went unmatched; the mapper's generic phrasing cannot name them.
    const { updateJobStatus, deps } = makeDeps();

    reportJobCheckRunCompletion(deps, {
      runId: 'run-1',
      jobId: 'job-1',
      jobName: 'build',
      status: ExecutionJobStatus.enum.unroutable,
      description: 'No connected agent matches runsOn [gpu]',
    });

    expect(updateJobStatus.mock.calls[0][0].description).toBe(
      'No connected agent matches runsOn [gpu]',
    );
  });

  it('leaves the description to the mapper for non-failure terminal statuses', () => {
    const { updateJobStatus, deps } = makeDeps();

    reportJobCheckRunCompletion(deps, {
      runId: 'run-1',
      jobId: 'job-1',
      jobName: 'build',
      status: ExecutionJobStatus.enum.skipped,
      data: { error: 'condition not met' },
    });

    expect(updateJobStatus.mock.calls[0][0].description).toBeUndefined();
  });

  it('contains a throw raised while building the report', () => {
    // The tracker calls this from `onJobStatus`, BEFORE it emits job-complete
    // and runs the needs/wave scheduler hooks. `buildJobFailureDescription`
    // reads the agent-supplied payload, so a malformed `stepResults` entry
    // raises here — and an escaping throw would abort the rest of that status
    // application, stranding every downstream job of a failed one.
    const updateJobStatus = vi.fn();
    const deps = {
      checkRunReporter: { updateJobStatus },
      getExecutionContext: vi.fn(() => execContext),
    };

    expect(() =>
      reportJobCheckRunCompletion(deps, {
        runId: 'run-1',
        jobId: 'job-1',
        jobName: 'build',
        status: ExecutionJobStatus.enum.failed,
        // A null entry: `s.status` on it throws inside the failed-step scan.
        data: { stepResults: [null] },
      }),
    ).not.toThrow();

    expect(updateJobStatus).not.toHaveBeenCalled();
  });

  it('skips when the run has no execution context', () => {
    const { updateJobStatus, deps } = makeDeps(null);

    reportJobCheckRunCompletion(deps, {
      runId: 'gone',
      jobId: 'job-1',
      jobName: 'build',
      status: ExecutionJobStatus.enum.success,
    });

    expect(updateJobStatus).not.toHaveBeenCalled();
  });
});
