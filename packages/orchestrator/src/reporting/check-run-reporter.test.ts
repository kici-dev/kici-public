import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CheckRunReporter, buildJobFailureDescription } from './check-run-reporter.js';
import { ProviderRegistry, type ProviderBundle } from '../provider-registry.js';
import {
  ExecutionJobStatus,
  ExecutionStepStatus,
  CheckRunConclusion,
  TERMINAL_JOB_STATES,
} from '@kici-dev/engine';
import { REDUCED_PRIVILEGE_MARKER } from '../security/reduced-privilege-note.js';
import { SUMMARY_BYTE_LIMIT } from './check-run-summary.js';

// Mock Prometheus metrics
vi.mock('../metrics/prometheus.js', () => ({
  githubCheckRunTotal: { add: vi.fn() },
}));

// -- Mock createInstallationOctokit --

let checkRunIdCounter = 1000;
const mockChecksCreate = vi.fn().mockImplementation(() => {
  const id = checkRunIdCounter++;
  return Promise.resolve({ data: { id } });
});
const mockChecksUpdate = vi.fn().mockResolvedValue({});
const mockChecksListForRef = vi.fn().mockResolvedValue({ data: { check_runs: [] } });

vi.mock('../providers/github/auth.js', () => ({
  createInstallationOctokit: vi.fn().mockReturnValue({
    checks: {
      create: (...args: unknown[]) => mockChecksCreate(...args),
      update: (...args: unknown[]) => mockChecksUpdate(...args),
      listForRef: (...args: unknown[]) => mockChecksListForRef(...args),
    },
  }),
}));

// -- Mock the app-level Octokit used only by stale check-run cleanup --
//
// Cleanup is the one path that discovers check runs through the GitHub API
// instead of the in-memory id map, so it authenticates as the App to resolve
// the repository's installation before listing.
const mockGetRepoInstallation = vi.fn().mockResolvedValue({ data: { id: 77 } });

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    apps = {
      getRepoInstallation: (...args: unknown[]) => mockGetRepoInstallation(...args),
    };
  },
}));

vi.mock('@octokit/auth-app', () => ({ createAppAuth: vi.fn() }));

const githubConfig = {
  appId: '12345',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
};

/**
 * An all-stub `CheckRunTrackingStore`. Shared by the tracking-store suite and
 * the cross-repository suite below, which overrides `getCheckRunId` on top of
 * it — both need the full method surface, since every write-through the
 * reporter performs would otherwise throw into a swallowing catch and read as
 * a passing test.
 */
function createTrackingStoreStub() {
  return {
    setCheckRunId: vi.fn().mockResolvedValue(undefined),
    getCheckRunId: vi.fn().mockResolvedValue(undefined),
    markBuildCreationPending: vi.fn().mockResolvedValue(undefined),
    markBuildCreationComplete: vi.fn().mockResolvedValue(undefined),
    setStepProgress: vi.fn().mockResolvedValue(undefined),
    markInProgressSent: vi.fn().mockResolvedValue(undefined),
    markTerminalSent: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue(undefined),
    deleteRow: vi.fn().mockResolvedValue(false),
    listKeysByRunId: vi.fn().mockResolvedValue([]),
    deleteByRunId: vi.fn().mockResolvedValue(0),
    pruneStale: vi.fn().mockResolvedValue(0),
  };
}

describe('CheckRunReporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRunIdCounter = 1000;
  });

  describe('setPending', () => {
    it('creates check runs for workflow and jobs via checks.create', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'build',
        jobNames: ['test', 'lint'],
        installationId: 42,
      });

      // Wait for fire-and-forget to complete
      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(3);
      });

      // Overall workflow check run
      expect(mockChecksCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'myorg',
          repo: 'myrepo',
          name: 'kici/build',
          head_sha: 'abc123',
          status: 'queued',
          output: expect.objectContaining({
            title: 'KiCI: build',
            summary: expect.stringContaining('Waiting for agent...'),
          }),
        }),
      );

      // Per-job check runs
      expect(mockChecksCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'kici/build/job/test',
          head_sha: 'abc123',
          status: 'queued',
        }),
      );
      expect(mockChecksCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'kici/build/job/lint',
          head_sha: 'abc123',
          status: 'queued',
        }),
      );
    });

    it('handles non-GitHub provider gracefully (no-op with log)', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'gitlab',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'build',
        jobNames: ['test'],
        installationId: 42,
      });

      // Give the fire-and-forget a tick to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(mockChecksCreate).not.toHaveBeenCalled();
    });

    it('skips when githubConfig is missing', async () => {
      const reporter = new CheckRunReporter({});

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'build',
        jobNames: ['test'],
        installationId: 42,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(mockChecksCreate).not.toHaveBeenCalled();
    });

    it('skips when installationId is missing', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'build',
        jobNames: ['test'],
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(mockChecksCreate).not.toHaveBeenCalled();
    });
  });

  describe('updateJobStatus', () => {
    it('updates job check run with success conclusion', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      // First, create check runs so IDs are tracked
      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      // Now update job status
      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.success,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'myorg',
          repo: 'myrepo',
          check_run_id: 1001, // Second check run created (after workflow)
          status: 'completed',
          conclusion: CheckRunConclusion.enum.success,
          completed_at: expect.any(String),
          output: expect.objectContaining({
            title: 'KiCI: CI/test',
            summary: expect.stringContaining('Job passed'),
          }),
        }),
      );
    });

    /**
     * The trust policy let the run proceed, so no security check was ever
     * posted and the job simply fails on something the run was never given.
     * The two checks that do land — this one and the `kici/<workflow>`
     * roll-up — are where the contributor can be told why.
     */
    async function completeJobWithPosture(over: {
      trustTier?: string;
      lockFileSource?: string;
    }): Promise<string> {
      const reporter = new CheckRunReporter({ githubConfig });
      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });
      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.failed,
        installationId: 42,
        ...over,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });
      return String(mockChecksUpdate.mock.calls[0][0].output.summary);
    }

    it('leads a completed job summary with the reduced-privilege note', async () => {
      const summary = await completeJobWithPosture({
        trustTier: 'unknown',
        lockFileSource: 'base',
      });

      expect(summary.startsWith(REDUCED_PRIVILEGE_MARKER)).toBe(true);
      expect(summary).toContain('Workflow definitions were read from the base branch');
      // The note leads; it does not replace the conclusion the job reported.
      expect(summary).toContain('Job failed');
    });

    it('omits the note for a trusted ref and for a run whose trust never resolved', async () => {
      expect(await completeJobWithPosture({ trustTier: 'trusted' })).not.toContain(
        REDUCED_PRIVILEGE_MARKER,
      );
      vi.clearAllMocks();
      expect(await completeJobWithPosture({})).not.toContain(REDUCED_PRIVILEGE_MARKER);
    });

    it('ignores a step-progress update that arrives after the job completed', async () => {
      // Observed on staging: `kici/e2e-fail/job/fail-job` sat at
      // `status: in_progress` with `conclusion: failure` already attached,
      // because a step status arriving after the completion scheduled a fresh
      // debounce timer that then PATCHed the check run back open. A check run
      // stuck in a non-terminal status is the very state this reporter exists
      // to avoid, so completion has to be a one-way latch.
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });
      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.failed,
        installationId: 42,
      });
      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });
      expect(mockChecksUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );

      // A late step status for the same job. Without the latch this takes the
      // "first running step" branch and PATCHes `in_progress` immediately.
      reporter.updateStepProgress({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        stepIndex: 0,
        stepName: 'late-step',
        state: ExecutionStepStatus.enum.running,
        installationId: 42,
      });

      // Drain the queue instead of sleeping: the suppressed path is a few
      // awaited promises, and a fixed sleep gets shorter than the work on load.
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));

      expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      expect(mockChecksUpdate.mock.calls.some((c) => c[0]?.status === 'in_progress')).toBe(false);
    });

    it('maps failed to failure conclusion', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.failed,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          conclusion: 'failure',
          completed_at: expect.any(String),
          output: expect.objectContaining({
            summary: expect.stringContaining('Job failed'),
          }),
        }),
      );
    });

    it('maps cancelled to cancelled conclusion', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.cancelled,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          conclusion: CheckRunConclusion.enum.cancelled,
          completed_at: expect.any(String),
          output: expect.objectContaining({
            summary: expect.stringContaining('Execution cancelled'),
          }),
        }),
      );
    });

    it('uses custom description when provided', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.failed,
        installationId: 42,
        description: 'Step "Build" failed with exit code 1',
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          completed_at: expect.any(String),
          output: expect.objectContaining({
            summary: expect.stringContaining('Step "Build" failed with exit code 1'),
          }),
        }),
      );
    });

    it('skips when check run ID is not found (warning, no crash)', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      // Don't call setPending -- no check run IDs tracked
      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.success,
        installationId: 42,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(mockChecksUpdate).not.toHaveBeenCalled();
    });

    it('handles non-GitHub provider gracefully', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.updateJobStatus({
        provider: 'bitbucket',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.success,
        installationId: 42,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(mockChecksUpdate).not.toHaveBeenCalled();
    });
  });

  describe('the reduced-privilege note and the summary byte cap', () => {
    it('keeps a note-led job summary under the API cap', async () => {
      // `buildCheckRunSummary` spends the byte budget on its own, so a note
      // added afterwards could push the update over the cap and GitHub would
      // reject it outright — leaving the check run unresolved, which is
      // strictly worse than a shorter log excerpt. The budget itself is pinned
      // at its own seam in check-run-summary.test.ts; this pins the invariant
      // end to end.
      // The rich-summary branch needs a log buffer; an empty one keeps the
      // fixture cheap while still taking that path.
      const reporter = new CheckRunReporter({
        githubConfig,
        stepLogBuffer: { getLastLines: () => undefined } as unknown as never,
      });
      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });
      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.failed,
        installationId: 42,
        runIdForLogs: 'run-1',
        jobId: 'job-1',
        data: {
          // ~30 KB of step-error text: well past the note's own size, and
          // inside the cap so the builder returns a real summary rather than
          // its minimal fallback.
          stepResults: Array.from({ length: 15 }, (_, i) => ({
            name: `step-${i}`,
            status: 'failed',
            error: 'e'.repeat(2000),
          })),
        },
        trustTier: 'unknown',
        lockFileSource: 'base',
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      const summary = String(mockChecksUpdate.mock.calls[0][0].output.summary);
      // Non-vacuity: the body really is at the scale the budget governs, and
      // the note really is present in the string being measured.
      expect(Buffer.byteLength(summary, 'utf-8')).toBeGreaterThan(10_000);
      expect(summary.startsWith(REDUCED_PRIVILEGE_MARKER)).toBe(true);
      expect(Buffer.byteLength(summary, 'utf-8')).toBeLessThanOrEqual(SUMMARY_BYTE_LIMIT);
    });

    it('leads the workflow roll-up check with the note too', async () => {
      // The roll-up is the check a branch-protection rule usually requires, so
      // a contributor may read only this one.
      const reporter = new CheckRunReporter({ githubConfig });
      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });
      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.failed,
        installationId: 42,
        trustTier: 'unknown',
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      const summary = String(mockChecksUpdate.mock.calls[0][0].output.summary);
      expect(summary.startsWith(REDUCED_PRIVILEGE_MARKER)).toBe(true);
      // The note leads; it does not replace the roll-up's own conclusion.
      expect(summary).toContain('One or more jobs failed');
    });

    it('leaves the workflow roll-up alone for a trusted ref', async () => {
      const reporter = new CheckRunReporter({ githubConfig });
      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });
      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.success,
        installationId: 42,
        trustTier: 'trusted',
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      expect(String(mockChecksUpdate.mock.calls[0][0].output.summary)).not.toContain(
        REDUCED_PRIVILEGE_MARKER,
      );
    });
  });

  describe('updateWorkflowStatus', () => {
    it('updates workflow check run with success conclusion', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.success,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'myorg',
          repo: 'myrepo',
          check_run_id: 1000, // First check run created (workflow)
          status: 'completed',
          conclusion: CheckRunConclusion.enum.success,
          completed_at: expect.any(String),
          output: expect.objectContaining({
            title: 'KiCI: CI',
            summary: expect.stringContaining('All jobs passed'),
          }),
        }),
      );
    });

    it('maps failed to failure with "One or more jobs failed"', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.failed,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          conclusion: 'failure',
          completed_at: expect.any(String),
          output: expect.objectContaining({
            summary: expect.stringContaining('One or more jobs failed'),
          }),
        }),
      );
    });

    it('maps cancelled to cancelled conclusion', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.cancelled,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          conclusion: CheckRunConclusion.enum.cancelled,
          completed_at: expect.any(String),
          output: expect.objectContaining({
            summary: expect.stringContaining('Execution cancelled'),
          }),
        }),
      );
    });

    it('uses custom description when provided', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.failed,
        installationId: 42,
        description: 'Job "deploy" failed',
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          completed_at: expect.any(String),
          output: expect.objectContaining({
            summary: expect.stringContaining('Job "deploy" failed'),
          }),
        }),
      );
    });

    it('skips when check run ID is not found', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.success,
        installationId: 42,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(mockChecksUpdate).not.toHaveBeenCalled();
    });
  });

  describe('terminal check-run updates record that they were sent', () => {
    /**
     * Minimal tracking-store double. Only the methods the reporter calls on
     * this path are implemented; the rest resolve so a write-through never
     * throws for an unrelated reason.
     */
    function makeTrackingStore() {
      return {
        setCheckRunId: vi.fn().mockResolvedValue(undefined),
        getCheckRunId: vi.fn().mockResolvedValue(undefined),
        markBuildCreationPending: vi.fn().mockResolvedValue(undefined),
        markBuildCreationComplete: vi.fn().mockResolvedValue(undefined),
        setStepProgress: vi.fn().mockResolvedValue(undefined),
        markInProgressSent: vi.fn().mockResolvedValue(undefined),
        markTerminalSent: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockResolvedValue(undefined),
        deleteRow: vi.fn().mockResolvedValue(false),
        listKeysByRunId: vi.fn().mockResolvedValue([]),
        deleteByRunId: vi.fn().mockResolvedValue(0),
      };
    }

    async function seedWorkflowCheckRun(reporter: CheckRunReporter) {
      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });
      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });
    }

    it('drops an in-flight in_progress write once the job has completed (no reopened check run)', async () => {
      // Reproduces the malformed `status: in_progress, conclusion: <terminal>`
      // state seen on a real failed-job check run: a step-progress in_progress
      // write passes its `terminalSent` guard, then the job completes — latching
      // the key and PATCHing `completed` — while the in_progress write is still
      // awaiting its tracking-store persist. The final latch re-check inside
      // updateCheckRun must drop the now-obsolete in_progress PATCH so it cannot
      // land after the completion and reopen the check run.
      let releaseStepPersist: () => void = () => {};
      const stepPersistGate = new Promise<void>((resolve) => {
        releaseStepPersist = resolve;
      });
      const trackingStore = makeTrackingStore();
      // Hold the in_progress path parked at its persist await, past the guard.
      trackingStore.setStepProgress.mockImplementation(() => stepPersistGate);

      const reporter = new CheckRunReporter({
        githubConfig,
        trackingStore: trackingStore as never,
      });
      await seedWorkflowCheckRun(reporter);

      // 1. First step goes running: the in_progress write starts and parks at the
      //    gated setStepProgress (its terminalSent guard has already passed).
      reporter.updateStepProgress({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        stepIndex: 0,
        stepName: 'build',
        state: ExecutionStepStatus.enum.running,
        installationId: 42,
        runId: 'run-1',
      });

      // 2. The job fails while the in_progress write is parked: latches the key
      //    and PATCHes `completed`/`failure`.
      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.failed,
        installationId: 42,
        runId: 'run-1',
      });
      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'completed', conclusion: 'failure' }),
        );
      });

      // 3. Release the parked in_progress write. updateCheckRun's re-check must
      //    now see the latch and drop the PATCH.
      releaseStepPersist();
      await new Promise((r) => setTimeout(r, 50));

      const inProgressWrites = mockChecksUpdate.mock.calls.filter(
        (c) => (c[0] as { status?: string }).status === 'in_progress',
      );
      expect(
        inProgressWrites,
        'the in-flight in_progress write must be dropped after completion',
      ).toHaveLength(0);
      // The check run stays terminal.
      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', conclusion: 'failure' }),
      );
    });

    it('serializes PATCHes per key so a live in_progress write cannot land after completion', async () => {
      // The final latch re-check inside updateCheckRun runs BEFORE its network
      // PATCH, so an in_progress PATCH that has passed the check and is awaiting
      // GitHub can still land after the terminal `completed` PATCH and reopen
      // the check run — the `{ status: in_progress, conclusion: failure }` state
      // seen on a real failed-job check. The guard above parks the write before
      // the PATCH; this one parks it mid-PATCH, which only per-key serialization
      // of updateCheckRun can close: the completed PATCH must not be issued
      // while the in_progress PATCH is still in flight for the same key.
      let releaseInProgress: () => void = () => {};
      const inProgressInFlight = new Promise<void>((resolve) => {
        releaseInProgress = resolve;
      });
      mockChecksUpdate.mockImplementation((params: { status?: string }) => {
        if (params.status === 'in_progress') return inProgressInFlight.then(() => ({}));
        return Promise.resolve({});
      });

      const trackingStore = makeTrackingStore();
      const reporter = new CheckRunReporter({
        githubConfig,
        trackingStore: trackingStore as never,
      });
      await seedWorkflowCheckRun(reporter);

      // 1. First step running: the in_progress PATCH passes every guard and
      //    parks in flight at octokit.checks.update, holding the per-key lock.
      reporter.updateStepProgress({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        stepIndex: 0,
        stepName: 'build',
        state: ExecutionStepStatus.enum.running,
        installationId: 42,
        runId: 'run-1',
      });
      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'in_progress' }),
        );
      });

      // 2. The job fails while the in_progress PATCH is still in flight. The
      //    completion PATCH must NOT be issued until the in_progress one settles.
      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.failed,
        installationId: 42,
        runId: 'run-1',
      });
      await new Promise((r) => setTimeout(r, 50));

      // Discriminator: with per-key serialization the completed PATCH is blocked
      // behind the in-flight in_progress PATCH. Without it, both PATCHes race at
      // GitHub and the check run can be left reopened.
      const completedIssuedWhileInFlight = mockChecksUpdate.mock.calls.some(
        (c) => (c[0] as { status?: string }).status === 'completed',
      );
      expect(
        completedIssuedWhileInFlight,
        'the completed PATCH must not be issued while an in_progress PATCH is still in flight for the same key',
      ).toBe(false);

      // 3. Release the in_progress PATCH. Completion now proceeds and the
      //    terminal state is the last write.
      releaseInProgress();
      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'completed', conclusion: 'failure' }),
        );
      });
    });

    it('stamps terminal_sent_at when a completed update succeeds', async () => {
      const trackingStore = makeTrackingStore();
      const reporter = new CheckRunReporter({
        githubConfig,
        trackingStore: trackingStore as never,
      });
      await seedWorkflowCheckRun(reporter);

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.success,
        installationId: 42,
        runId: 'run-xyz',
      });

      await vi.waitFor(() => {
        expect(trackingStore.markTerminalSent).toHaveBeenCalledTimes(1);
      });
      // The runId must be threaded: the stamp is an upsert, so a row it
      // INSERTs without run_id could never be reaped by deleteByRunId.
      expect(trackingStore.markTerminalSent).toHaveBeenCalledWith(
        {
          provider: 'github',
          owner: 'myorg',
          repo: 'myrepo',
          sha: 'abc123',
          checkName: 'kici/CI',
        },
        'run-xyz',
      );
    });

    it('does NOT stamp it for an in_progress update', async () => {
      const trackingStore = makeTrackingStore();
      const reporter = new CheckRunReporter({
        githubConfig,
        trackingStore: trackingStore as never,
      });
      await seedWorkflowCheckRun(reporter);

      reporter.updateStepProgress({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        stepIndex: 0,
        stepName: 'build',
        state: ExecutionStepStatus.enum.running,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'in_progress' }),
        );
      });
      expect(trackingStore.markTerminalSent).not.toHaveBeenCalled();
    });

    it('does not stamp it when the GitHub PATCH throws', async () => {
      const trackingStore = makeTrackingStore();
      const reporter = new CheckRunReporter({
        githubConfig,
        trackingStore: trackingStore as never,
      });
      await seedWorkflowCheckRun(reporter);
      mockChecksUpdate.mockRejectedValueOnce(new Error('boom'));

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.success,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });
      // Drain the queue rather than sleeping a wall-clock interval. Everything
      // after the PATCH settles on this path is synchronous or a single awaited
      // promise, so a handful of macrotask turns is enough — and unlike a fixed
      // sleep it does not get shorter than the work under load.
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(trackingStore.markTerminalSent).not.toHaveBeenCalled();
    });

    it('still completes the GitHub update when the marker write fails', async () => {
      const trackingStore = makeTrackingStore();
      trackingStore.markTerminalSent.mockRejectedValue(new Error('db down'));
      const reporter = new CheckRunReporter({
        githubConfig,
        trackingStore: trackingStore as never,
      });
      await seedWorkflowCheckRun(reporter);

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.success,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(trackingStore.markTerminalSent).toHaveBeenCalledTimes(1);
      });
      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
    });
  });

  describe('full lifecycle', () => {
    it('setPending -> updateJobStatus -> updateWorkflowStatus', async () => {
      const reporter = new CheckRunReporter({ githubConfig });

      // 1. Create check runs (queued)
      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test', 'build'],
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(3); // workflow + 2 jobs
      });

      // 2. Update first job (success)
      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'test',
        state: ExecutionJobStatus.enum.success,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      // 3. Update second job (failed)
      reporter.updateJobStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobName: 'build',
        state: ExecutionJobStatus.enum.failed,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(2);
      });

      // 4. Update overall workflow (failed)
      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.failed,
        installationId: 42,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(3);
      });

      // Verify IDs: workflow=1000, test=1001, build=1002
      const updateCalls = mockChecksUpdate.mock.calls;

      // Job 'test' update (check_run_id 1001)
      expect(updateCalls[0][0].check_run_id).toBe(1001);
      expect(updateCalls[0][0].conclusion).toBe(CheckRunConclusion.enum.success);

      // Job 'build' update (check_run_id 1002)
      expect(updateCalls[1][0].check_run_id).toBe(1002);
      expect(updateCalls[1][0].conclusion).toBe('failure');

      // Workflow update (check_run_id 1000)
      expect(updateCalls[2][0].check_run_id).toBe(1000);
      expect(updateCalls[2][0].conclusion).toBe('failure');
    });
  });

  describe('error handling', () => {
    it('logs 403 errors with rate limit headers on create', async () => {
      const error = Object.assign(new Error('Forbidden'), {
        status: 403,
        response: {
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1234567890',
          },
        },
      });
      mockChecksCreate.mockRejectedValueOnce(error);

      const reporter = new CheckRunReporter({ githubConfig });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });

      // Wait for the fire-and-forget to complete (it shouldn't throw)
      await new Promise((r) => setTimeout(r, 100));

      // Should not throw -- error is caught internally
      expect(true).toBe(true);
    });

    it('does not propagate API errors (fire-and-forget)', async () => {
      mockChecksCreate.mockRejectedValueOnce(new Error('Network error'));

      const reporter = new CheckRunReporter({ githubConfig });

      // This should not throw
      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        jobNames: ['test'],
        installationId: 42,
      });

      // Wait for the fire-and-forget to complete
      await new Promise((r) => setTimeout(r, 100));

      // No exception thrown -- fire-and-forget pattern works
      expect(true).toBe(true);
    });
  });

  describe('tracking-store interaction', () => {
    it('records the runId when persisting a freshly created check-run ID', async () => {
      const trackingStore = createTrackingStoreStub();
      const reporter = new CheckRunReporter({
        githubConfig,
        trackingStore: trackingStore as never,
      });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'build',
        jobNames: ['test'],
        installationId: 42,
        runId: 'run-xyz',
      });

      await vi.waitFor(() => {
        expect(trackingStore.setCheckRunId).toHaveBeenCalledWith(
          expect.objectContaining({ checkName: 'kici/build' }),
          expect.any(Number),
          'run-xyz',
        );
      });
    });

    it('does not delete database rows on cleanupRun', async () => {
      const trackingStore = createTrackingStoreStub();
      const reporter = new CheckRunReporter({
        githubConfig,
        trackingStore: trackingStore as never,
      });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'build',
        jobNames: ['test'],
        installationId: 42,
        runId: 'run-xyz',
      });
      await vi.waitFor(() => expect(trackingStore.setCheckRunId).toHaveBeenCalled());

      reporter.cleanupRun('run-xyz');

      expect(trackingStore.deleteByRunId).not.toHaveBeenCalled();
    });

    /**
     * Tracking-store fake with real row state: `setCheckRunId` inserts and
     * `deleteByRunId` removes, so a load-through after a delete genuinely
     * misses. A stub whose delete is a no-op would pass the load-through
     * assertion below whether or not `cleanupRun` still deleted.
     */
    function createStatefulTrackingStore() {
      const rows = new Map<string, { checkRunId: number; runId?: string; terminalSentAt?: Date }>();
      const id = (k: { checkName: string }) => k.checkName;
      const base = createTrackingStoreStub();
      base.setCheckRunId.mockImplementation(
        async (k: { checkName: string }, checkRunId: number, runId?: string) => {
          rows.set(id(k), { checkRunId, runId });
        },
      );
      base.getCheckRunId.mockImplementation(async (k: { checkName: string }) => {
        return rows.get(id(k))?.checkRunId;
      });
      // Reads the SAME row as `getCheckRunId`, because the real store does:
      // both go through `selectRow`. A fake where the two disagree models a
      // state the database cannot be in.
      base.getState.mockImplementation(async (k: { checkName: string }) => {
        const row = rows.get(id(k));
        if (!row) return undefined;
        return {
          checkRunId: row.checkRunId,
          stepProgress: [],
          ...(row.runId !== undefined ? { runId: row.runId } : {}),
          ...(row.terminalSentAt !== undefined ? { terminalSentAt: row.terminalSentAt } : {}),
        };
      });
      base.markTerminalSent.mockImplementation(async (k: { checkName: string }) => {
        const row = rows.get(id(k));
        if (row) row.terminalSentAt = new Date();
      });
      base.deleteByRunId.mockImplementation(async (runId: string) => {
        let n = 0;
        for (const [key, row] of rows) {
          if (row.runId === runId) {
            rows.delete(key);
            n++;
          }
        }
        return n;
      });
      return { store: base, rows };
    }

    it('the stateful fake really loses rows when deleteByRunId runs', async () => {
      // Positive control for the pin below: prove the fake can detect a delete
      // at all, so a green load-through assertion means something.
      const { store, rows } = createStatefulTrackingStore();
      await store.setCheckRunId({ checkName: 'kici/build' } as never, 4242, 'run-xyz');
      expect(await store.getCheckRunId({ checkName: 'kici/build' } as never)).toBe(4242);

      expect(await store.deleteByRunId('run-xyz')).toBe(1);

      expect(rows.size).toBe(0);
      expect(await store.getCheckRunId({ checkName: 'kici/build' } as never)).toBeUndefined();
    });

    it('still resolves a check-run ID from the store after cleanupRun evicted L1', async () => {
      // The point of leaving the row in place: a terminal PATCH that lands
      // after the run was pruned must still find its check-run ID. With the
      // row deleted at prune time this load-through returns undefined and the
      // check run stays unresolved on the commit forever.
      const { store: trackingStore } = createStatefulTrackingStore();
      const reporter = new CheckRunReporter({
        githubConfig,
        trackingStore: trackingStore as never,
      });

      reporter.setPending({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'build',
        jobNames: ['test'],
        installationId: 42,
        runId: 'run-xyz',
      });
      await vi.waitFor(() => expect(trackingStore.setCheckRunId).toHaveBeenCalledTimes(2));
      const workflowCheckRunId = await trackingStore.getCheckRunId({
        checkName: 'kici/build',
      } as never);
      expect(workflowCheckRunId).toEqual(expect.any(Number));

      reporter.cleanupRun('run-xyz');
      // L1 is empty now, so the update has to load through to the store.

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'build',
        overallStatus: ExecutionJobStatus.enum.success,
        installationId: 42,
        runId: 'run-xyz',
      });

      await vi.waitFor(() => {
        // `getState`, not `getCheckRunId`: the read-through pulls the whole row
        // so it can rehydrate the terminal latch alongside the id. Asserting
        // the old method here would pass on the test's own direct call above
        // rather than on anything the reporter did.
        expect(trackingStore.getState).toHaveBeenCalledWith(
          expect.objectContaining({ checkName: 'kici/build' }),
        );
        expect(mockChecksUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ check_run_id: workflowCheckRunId, status: 'completed' }),
        );
      });
    });

    it('does not reopen a completed job check run when a step arrives after cleanupRun', async () => {
      // The prune deliberately keeps the `check_run_tracking` row so a late
      // update can still resolve its check-run id — and used to drop the
      // in-memory terminal latch with it. That pairing is what produced
      // `status: in_progress` with `conclusion: failure` already attached: the
      // id came back from the row, the latch did not, and the late step
      // PATCHed the completed check run back open.
      const { store: trackingStore } = createStatefulTrackingStore();
      const reporter = new CheckRunReporter({
        githubConfig,
        trackingStore: trackingStore as never,
      });
      const job = {
        provider: 'github' as const,
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'build',
        jobName: 'test',
        installationId: 42,
        runId: 'run-xyz',
      };

      reporter.setPending({ ...job, jobNames: ['test'] });
      await vi.waitFor(() => expect(trackingStore.setCheckRunId).toHaveBeenCalledTimes(2));

      reporter.updateJobStatus({ ...job, state: ExecutionJobStatus.enum.failed });
      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'completed', conclusion: 'failure' }),
        );
        expect(trackingStore.markTerminalSent).toHaveBeenCalled();
      });
      mockChecksUpdate.mockClear();

      // The run is pruned: every in-memory entry for it goes, including the
      // latch. Only the retained row remembers the completion.
      reporter.cleanupRun('run-xyz');

      reporter.updateStepProgress({
        ...job,
        stepIndex: 0,
        stepName: 'late-step',
        state: ExecutionStepStatus.enum.running,
      });

      // Drain rather than sleep — the suppressed path is a few awaited
      // promises, and a fixed sleep gets shorter than the work under load.
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));

      expect(mockChecksUpdate).not.toHaveBeenCalled();
    });

    it('still publishes step progress after cleanupRun when the job never completed', async () => {
      // Positive control for the pin above. Without it, a reporter that simply
      // stopped publishing progress after any prune would pass that test while
      // being broken — the assertion there is an absence, and an absence proves
      // nothing unless the same setup can produce a presence.
      const { store: trackingStore } = createStatefulTrackingStore();
      const reporter = new CheckRunReporter({
        githubConfig,
        trackingStore: trackingStore as never,
      });
      const job = {
        provider: 'github' as const,
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'build',
        jobName: 'test',
        installationId: 42,
        runId: 'run-xyz',
      };

      reporter.setPending({ ...job, jobNames: ['test'] });
      await vi.waitFor(() => expect(trackingStore.setCheckRunId).toHaveBeenCalledTimes(2));
      mockChecksUpdate.mockClear();

      // Pruned with no terminal update ever sent, so the retained row carries
      // no `terminal_sent_at` and the late step is legitimate.
      reporter.cleanupRun('run-xyz');

      reporter.updateStepProgress({
        ...job,
        stepIndex: 0,
        stepName: 'late-step',
        state: ExecutionStepStatus.enum.running,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'in_progress' }),
        );
      });
    });
  });
});

describe('CheckRunReporter multi-app credential resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRunIdCounter = 1000;
  });

  function createMockBundle(appConfig: { appId: string; privateKey: string }): ProviderBundle {
    return {
      normalizer: {
        provider: 'github' as const,
        extractRoutingKey: vi.fn(),
        extractDeliveryId: vi.fn(),
        extractEventType: vi.fn(),
        verifySignature: vi.fn(),
        normalizeEvent: vi.fn(),
      },
      lockFileFetcher: {
        provider: 'github' as const,
        fetchLockFile: vi.fn(),
      },
      changedFilesFetcher: {
        provider: 'github' as const,
        getChangedFiles: vi.fn(),
      },
      cloneTokenProvider: {
        provider: 'github' as const,
        createCloneToken: vi.fn(),
        getAppConfig: () => appConfig,
      },
      repoUrlBuilder: {
        provider: 'github' as const,
        buildCloneUrl: vi.fn(),
        buildRawFileUrl: vi.fn(),
      },
    };
  }

  it('resolves credentials from providerRegistry when routingKey is provided', async () => {
    const appConfig = {
      appId: '99999',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\napp-99999\n-----END RSA PRIVATE KEY-----',
    };
    const registry = new ProviderRegistry();
    registry.registerByRoutingKey('github:99999', createMockBundle(appConfig));

    const reporter = new CheckRunReporter({ providerRegistry: registry });

    reporter.setPending({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'build',
      jobNames: ['test'],
      installationId: 42,
      routingKey: 'github:99999',
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    // Verify createInstallationOctokit was called with the app-specific config
    const { createInstallationOctokit } = await import('../providers/github/auth.js');
    expect(createInstallationOctokit).toHaveBeenCalledWith(appConfig, 42);
  });

  it('uses different credentials for different routing keys', async () => {
    const { createInstallationOctokit } = await import('../providers/github/auth.js');
    const mockedCreateOctokit = vi.mocked(createInstallationOctokit);
    mockedCreateOctokit.mockClear();

    const app1Config = {
      appId: '11111',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\napp-11111\n-----END RSA PRIVATE KEY-----',
    };
    const app2Config = {
      appId: '22222',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\napp-22222\n-----END RSA PRIVATE KEY-----',
    };

    const registry = new ProviderRegistry();
    registry.registerByRoutingKey('github:11111', createMockBundle(app1Config));
    registry.registerByRoutingKey('github:22222', createMockBundle(app2Config));

    const reporter = new CheckRunReporter({ providerRegistry: registry });

    // Create check runs with app 1
    reporter.setPending({
      provider: 'github',
      owner: 'org1',
      repo: 'repo1',
      sha: 'sha1',
      workflowName: 'CI',
      jobNames: ['test'],
      installationId: 100,
      routingKey: 'github:11111',
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    // Create check runs with app 2
    reporter.setPending({
      provider: 'github',
      owner: 'org2',
      repo: 'repo2',
      sha: 'sha2',
      workflowName: 'CI',
      jobNames: ['lint'],
      installationId: 200,
      routingKey: 'github:22222',
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(4);
    });

    // doSetPending creates ONE octokit per setPending call (reused for all check runs)
    const calls = mockedCreateOctokit.mock.calls;
    expect(calls).toHaveLength(2);

    // First call: app1Config with installationId 100
    expect(calls[0][0]).toEqual(app1Config);
    expect(calls[0][1]).toBe(100);

    // Second call: app2Config with installationId 200
    expect(calls[1][0]).toEqual(app2Config);
    expect(calls[1][1]).toBe(200);
  });

  it('falls back to githubConfig when routingKey is not provided', async () => {
    const fallbackConfig = {
      appId: '12345',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfallback\n-----END RSA PRIVATE KEY-----',
    };
    const registry = new ProviderRegistry();

    const reporter = new CheckRunReporter({
      providerRegistry: registry,
      githubConfig: fallbackConfig,
    });

    reporter.setPending({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'build',
      jobNames: ['test'],
      installationId: 42,
      // No routingKey -- should fall back to githubConfig
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    const { createInstallationOctokit } = await import('../providers/github/auth.js');
    expect(createInstallationOctokit).toHaveBeenCalledWith(fallbackConfig, 42);
  });

  it('falls back to githubConfig when routing key not found in registry', async () => {
    const fallbackConfig = {
      appId: '12345',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfallback\n-----END RSA PRIVATE KEY-----',
    };
    const registry = new ProviderRegistry();
    // Registry is empty -- no bundles registered

    const reporter = new CheckRunReporter({
      providerRegistry: registry,
      githubConfig: fallbackConfig,
    });

    reporter.setPending({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'build',
      jobNames: ['test'],
      installationId: 42,
      routingKey: 'github:unknown',
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    const { createInstallationOctokit } = await import('../providers/github/auth.js');
    expect(createInstallationOctokit).toHaveBeenCalledWith(fallbackConfig, 42);
  });

  it('skips when no config is resolvable (no registry, no githubConfig)', async () => {
    const reporter = new CheckRunReporter({});

    reporter.setPending({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'build',
      jobNames: ['test'],
      installationId: 42,
      routingKey: 'github:12345',
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(mockChecksCreate).not.toHaveBeenCalled();
  });
});

describe('buildJobFailureDescription', () => {
  it('returns first failed step name and error from stepResults', () => {
    const result = buildJobFailureDescription({
      stepResults: [
        { name: 'setup', status: 'success' },
        { name: 'lint', status: 'failed', error: 'Process exited with code 1' },
        { name: 'test', status: 'skipped' },
      ],
    });
    expect(result).toBe("Step 'lint' failed: Process exited with code 1");
  });

  it('returns step name and exit code when no error message', () => {
    const result = buildJobFailureDescription({
      stepResults: [{ name: 'test', status: 'failed', exitCode: 2 }],
    });
    expect(result).toBe("Step 'test' failed (exit code 2)");
  });

  it('returns step name only when no error or exitCode', () => {
    const result = buildJobFailureDescription({
      stepResults: [{ name: 'deploy', status: 'failed' }],
    });
    expect(result).toBe("Step 'deploy' failed");
  });

  it('falls back to data.error when no stepResults', () => {
    const result = buildJobFailureDescription({
      error: 'Failed to clone repository',
    });
    expect(result).toBe('Job error: Failed to clone repository');
  });

  it('falls back to generic message when no data', () => {
    const result = buildJobFailureDescription({});
    expect(result).toBe('Job failed');
  });

  it('handles stepResults with error status', () => {
    const result = buildJobFailureDescription({
      stepResults: [{ name: 'compile', status: 'error', error: 'OOM killed' }],
    });
    expect(result).toBe("Step 'compile' failed: OOM killed");
  });

  it('prefers stepResults over top-level error', () => {
    const result = buildJobFailureDescription({
      stepResults: [{ name: 'build', status: 'failed', exitCode: 1 }],
      error: 'Generic error',
    });
    expect(result).toBe("Step 'build' failed (exit code 1)");
  });
});

describe('details_url with public alias', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRunIdCounter = 1000;
  });

  const ALIAS = 'oal_aaaaaaaaaaaa';
  const ORG_ID = 'org_aaaaaaaaaaaa';
  const RUN_ID = '11111111-2222-3333-4444-555555555555';

  it('emits details_url using the public alias when dashboardUrl + alias resolver are wired', async () => {
    const reporter = new CheckRunReporter({
      githubConfig,
      dashboardUrl: 'https://example.test/kici/dashboard',
      getOrgPublicAlias: () => ALIAS,
    });

    reporter.setPending({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'build',
      jobNames: ['test'],
      installationId: 42,
      runId: RUN_ID,
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    const expectedUrl = `https://example.test/kici/dashboard/r/orgs/${ALIAS}/runs/${RUN_ID}`;
    const allCalls = mockChecksCreate.mock.calls.map((c) => c[0] as { details_url?: string });
    for (const call of allCalls) {
      expect(call.details_url).toBe(expectedUrl);
      // Canonical org_<12-char> id must NEVER appear in the public link.
      expect(call.details_url).not.toContain(ORG_ID);
    }
  });

  it('strips a trailing slash on dashboardUrl', async () => {
    const reporter = new CheckRunReporter({
      githubConfig,
      dashboardUrl: 'https://example.test/kici/dashboard/',
      getOrgPublicAlias: () => ALIAS,
    });

    reporter.setPending({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'build',
      jobNames: ['test'],
      installationId: 42,
      runId: RUN_ID,
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    const expectedUrl = `https://example.test/kici/dashboard/r/orgs/${ALIAS}/runs/${RUN_ID}`;
    expect((mockChecksCreate.mock.calls[0][0] as any).details_url).toBe(expectedUrl);
  });

  it('omits details_url when dashboardUrl is unset (preserves today behaviour)', async () => {
    const reporter = new CheckRunReporter({
      githubConfig,
      getOrgPublicAlias: () => ALIAS,
    });

    reporter.setPending({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'build',
      jobNames: ['test'],
      installationId: 42,
      runId: RUN_ID,
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    expect((mockChecksCreate.mock.calls[0][0] as any).details_url).toBeUndefined();
  });

  it('omits details_url when alias resolver returns undefined', async () => {
    const reporter = new CheckRunReporter({
      githubConfig,
      dashboardUrl: 'https://example.test/kici/dashboard',
      getOrgPublicAlias: () => undefined,
    });

    reporter.setPending({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'build',
      jobNames: ['test'],
      installationId: 42,
      runId: RUN_ID,
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    expect((mockChecksCreate.mock.calls[0][0] as any).details_url).toBeUndefined();
  });

  it('omits details_url when no real runId is available (N/A sentinel)', async () => {
    const reporter = new CheckRunReporter({
      githubConfig,
      dashboardUrl: 'https://example.test/kici/dashboard',
      getOrgPublicAlias: () => ALIAS,
    });

    reporter.setPending({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'build',
      jobNames: ['test'],
      installationId: 42,
      // No runId, no AsyncLocalStorage context — resolveTraceIds yields 'N/A'.
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    expect((mockChecksCreate.mock.calls[0][0] as any).details_url).toBeUndefined();
  });

  it('propagates details_url through job-completion update', async () => {
    const reporter = new CheckRunReporter({
      githubConfig,
      dashboardUrl: 'https://example.test/kici/dashboard',
      getOrgPublicAlias: () => ALIAS,
    });

    reporter.setPending({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'CI',
      jobNames: ['test'],
      installationId: 42,
      runId: RUN_ID,
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    reporter.updateJobStatus({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'CI',
      jobName: 'test',
      state: ExecutionJobStatus.enum.success,
      installationId: 42,
      runId: RUN_ID,
    });

    await vi.waitFor(() => {
      expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    });

    const expectedUrl = `https://example.test/kici/dashboard/r/orgs/${ALIAS}/runs/${RUN_ID}`;
    expect((mockChecksUpdate.mock.calls[0][0] as any).details_url).toBe(expectedUrl);
  });

  it('updateJobStatus emits details_url with explicit runId outside ALS frame', async () => {
    // Regression: agent WS message handlers in app.ts call updateJobStatus
    // without a request-context ALS frame, so the reporter must accept an
    // explicit runId rather than relying on getRequestContext().
    const reporter = new CheckRunReporter({
      githubConfig,
      dashboardUrl: 'https://example.test/kici/dashboard',
      getOrgPublicAlias: () => ALIAS,
    });

    reporter.setPending({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'CI',
      jobNames: ['test'],
      installationId: 42,
      runId: RUN_ID,
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    // Explicit runId — no ALS context set up by the caller.
    reporter.updateJobStatus({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'CI',
      jobName: 'test',
      state: ExecutionJobStatus.enum.failed,
      installationId: 42,
      runId: RUN_ID,
    });

    await vi.waitFor(() => {
      expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    });
    const expectedUrl = `https://example.test/kici/dashboard/r/orgs/${ALIAS}/runs/${RUN_ID}`;
    expect((mockChecksUpdate.mock.calls[0][0] as any).details_url).toBe(expectedUrl);
  });

  it('updateWorkflowStatus emits details_url with explicit runId outside ALS frame', async () => {
    // Regression: orchestrator-core's onExecutionComplete callback fires
    // outside any request-context ALS frame, so the reporter must accept
    // an explicit runId for the workflow-level check-run completion path.
    const reporter = new CheckRunReporter({
      githubConfig,
      dashboardUrl: 'https://example.test/kici/dashboard',
      getOrgPublicAlias: () => ALIAS,
    });

    // Use setPendingAwait so the workflow check-run id is in cache before
    // updateWorkflowStatus runs its lookup (avoids fire-and-forget race).
    await reporter.setPendingAwait({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'CI',
      jobNames: [],
      installationId: 42,
      runId: RUN_ID,
    });

    expect(mockChecksCreate).toHaveBeenCalledTimes(1);

    reporter.updateWorkflowStatus({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'CI',
      overallStatus: ExecutionJobStatus.enum.failed,
      installationId: 42,
      runId: RUN_ID,
    });

    await vi.waitFor(() => {
      expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    });
    const expectedUrl = `https://example.test/kici/dashboard/r/orgs/${ALIAS}/runs/${RUN_ID}`;
    expect((mockChecksUpdate.mock.calls[0][0] as any).details_url).toBe(expectedUrl);
  });

  it('setOrgPublicAliasResolver late-binds the resolver', async () => {
    const reporter = new CheckRunReporter({
      githubConfig,
      dashboardUrl: 'https://example.test/kici/dashboard',
    });
    // First call: no resolver yet → omit details_url.
    reporter.setPending({
      provider: 'github',
      owner: 'a',
      repo: 'a',
      sha: 'a1',
      workflowName: 'w1',
      jobNames: [],
      installationId: 42,
      runId: RUN_ID,
    });
    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(1);
    });
    expect((mockChecksCreate.mock.calls[0][0] as any).details_url).toBeUndefined();

    // Late-bind the resolver, second call gets details_url.
    reporter.setOrgPublicAliasResolver(() => ALIAS);
    reporter.setPending({
      provider: 'github',
      owner: 'b',
      repo: 'b',
      sha: 'b1',
      workflowName: 'w2',
      jobNames: [],
      installationId: 42,
      runId: RUN_ID,
    });
    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });
    expect((mockChecksCreate.mock.calls[1][0] as any).details_url).toContain(`r/orgs/${ALIAS}/`);
  });
});

describe('check-run conclusion mappers cover every terminal job status', () => {
  type Mapper = (s: string, d?: string) => { conclusion: string; description: string };
  const mappers = ['mapBuildConclusion', 'mapJobConclusion', 'mapWorkflowConclusion'] as const;

  const call = (mapper: string, status: string): { conclusion: string; description: string } => {
    const reporter = new CheckRunReporter({ githubConfig });
    return (reporter as unknown as Record<string, Mapper>)[mapper](status);
  };

  /**
   * The conclusion each terminal status must map to — named explicitly rather
   * than asserted as "defined".
   *
   * A `toBeDefined()` loop would be satisfied by the catch-all `default` arm for
   * ANY input, including a future terminal status falling through it, so it
   * could not fail for the thing it exists to catch. Pinning the expected
   * conclusion means a status reaching the default arm (which returns `failure`
   * plus an "unrecognised status" description) fails every row that expects
   * something else, and the description assertion below catches the rest.
   */
  const EXPECTED_CONCLUSION: Record<string, string> = {
    [ExecutionJobStatus.enum.success]: CheckRunConclusion.enum.success,
    [ExecutionJobStatus.enum.failed]: CheckRunConclusion.enum.failure,
    [ExecutionJobStatus.enum.cancelled]: CheckRunConclusion.enum.cancelled,
    [ExecutionJobStatus.enum.skipped]: CheckRunConclusion.enum.cancelled,
    [ExecutionJobStatus.enum.timed_out_stale]: CheckRunConclusion.enum.timed_out,
    [ExecutionJobStatus.enum.drift_dropped]: CheckRunConclusion.enum.failure,
    [ExecutionJobStatus.enum.unroutable]: CheckRunConclusion.enum.failure,
  };

  it('names an expected conclusion for every terminal status', () => {
    // Guards the table itself: a terminal status added to the engine without a
    // row here would otherwise silently skip its assertion below.
    expect(Object.keys(EXPECTED_CONCLUSION).sort()).toEqual([...TERMINAL_JOB_STATES].sort());
  });

  for (const mapper of mappers) {
    for (const status of TERMINAL_JOB_STATES) {
      it(`${mapper} maps ${status} to its expected conclusion`, () => {
        const result = call(mapper, status);
        expect(result).toBeDefined();
        expect(result.conclusion).toBe(EXPECTED_CONCLUSION[status]);
        // The default arm's description says "unrecognised status"; a status
        // that reached it must not pass as a real mapping.
        expect(result.description).toBeTruthy();
        expect(result.description).not.toContain('unrecognised');
      });
    }
  }

  it('degrades an unrecognised status rather than returning undefined', () => {
    const result = call('mapJobConclusion', 'brand_new_status');
    expect(result).toBeDefined();
    expect(result.conclusion).toBe(CheckRunConclusion.enum.failure);
    expect(result.description).toContain('unrecognised');
  });
});
describe('cross-repository global workflow check runs', () => {
  // The acted-on repository (a global workflow's run is attributed here) and
  // the repository that DEFINES the workflow. Both define a workflow named
  // `ci`, which is legal: they are two lock files.
  const OWNER = 'acme';
  const REPO = 'app';
  const ACTED_ON = `${OWNER}/${REPO}`;
  const WORKFLOW_REPO = 'acme/ci-defs';
  const SHA = 'deadbeef';
  const WORKFLOW = 'ci';
  const JOB = 'test';

  /** Check-run ids the global run's OWN, qualified keys resolve to. */
  const GLOBAL_WORKFLOW_CHECK_ID = 9000;
  const GLOBAL_JOB_CHECK_ID = 9001;

  beforeEach(() => {
    vi.clearAllMocks();
    checkRunIdCounter = 2000;
  });

  /**
   * A tracking store that resolves ONLY the global run's qualified keys.
   *
   * Modelling the store this way is what turns each assertion below positive:
   * the global run posts to a check run of its own, so the test asserts WHICH
   * check run was PATCHed rather than waiting out a fixed delay to conclude
   * that none was. A wall-clock "nothing happened" assertion passes for free on
   * a loaded executor; this one cannot.
   *
   * Returning undefined for the acted-on repository's unqualified keys models
   * the documented cache-only fallback, where a write-through failed and L1 is
   * the only copy. That isolates the L1 state, which is what `cleanupRun`
   * evicts and what the last test here is about.
   */
  function createGlobalOnlyTrackingStore() {
    const qualified = `kici/${WORKFLOW_REPO}/${WORKFLOW}`;
    const idFor = (checkName: string): number | undefined => {
      if (checkName === qualified) return GLOBAL_WORKFLOW_CHECK_ID;
      if (checkName === `${qualified}/job/${JOB}`) return GLOBAL_JOB_CHECK_ID;
      return undefined;
    };
    return {
      ...createTrackingStoreStub(),
      getCheckRunId: vi.fn(async (key: { checkName: string }) => idFor(key.checkName)),
      // The reporter's read-through reads the whole row, not just the id — the
      // real store answers both from one `selectRow`, so the fake must too.
      getState: vi.fn(async (key: { checkName: string }) => {
        const checkRunId = idFor(key.checkName);
        return checkRunId === undefined ? undefined : { checkRunId, stepProgress: [] };
      }),
    };
  }

  /**
   * Create the acted-on repository's own `ci` check runs, exactly as the
   * per-repository dispatch path does. Returns the workflow check-run id and
   * the job check-run id the global run must not touch.
   */
  async function seedPerRepositoryChecks(
    reporter: CheckRunReporter,
  ): Promise<{ workflowCheckRunId: number; jobCheckRunId: number }> {
    await reporter.setPendingAwait({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: [JOB],
      installationId: 42,
      runId: 'run-per-repo',
    });
    expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    const workflowCheckRunId = (await mockChecksCreate.mock.results[0].value).data.id;
    const jobCheckRunId = (await mockChecksCreate.mock.results[1].value).data.id;
    mockChecksCreate.mockClear();
    return { workflowCheckRunId, jobCheckRunId };
  }

  it('names a global workflow check run after the repository that defines it', async () => {
    const reporter = new CheckRunReporter({ githubConfig });

    await reporter.setPendingAwait({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: [JOB],
      installationId: 42,
      workflowRepoIdentifier: WORKFLOW_REPO,
      runId: 'run-global',
    });

    expect(mockChecksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: OWNER,
        repo: REPO,
        name: `kici/${WORKFLOW_REPO}/${WORKFLOW}`,
        head_sha: SHA,
        output: expect.objectContaining({ title: `KiCI: ${WORKFLOW_REPO}/${WORKFLOW}` }),
      }),
    );
    expect(mockChecksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: `kici/${WORKFLOW_REPO}/${WORKFLOW}/job/${JOB}` }),
    );
  });

  it('leaves the name unqualified when the workflow is defined in the repository it ran against', async () => {
    // A global workflow firing on its own repository's event is not a
    // cross-repository run: the acted-on and defining repositories are the
    // same, so nothing can collide and the customer-visible name must not move.
    const reporter = new CheckRunReporter({ githubConfig });

    await reporter.setPendingAwait({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: [JOB],
      installationId: 42,
      workflowRepoIdentifier: ACTED_ON,
      runId: 'run-global-same-repo',
    });

    expect(mockChecksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: `kici/${WORKFLOW}` }),
    );
    expect(mockChecksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: `kici/${WORKFLOW}/job/${JOB}` }),
    );
  });

  it('completes its own workflow check run, not the acted-on repository one', async () => {
    const trackingStore = createGlobalOnlyTrackingStore();
    const reporter = new CheckRunReporter({ githubConfig, trackingStore: trackingStore as never });
    const { workflowCheckRunId } = await seedPerRepositoryChecks(reporter);

    reporter.updateWorkflowStatus({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      overallStatus: ExecutionJobStatus.enum.failed,
      installationId: 42,
      workflowRepoIdentifier: WORKFLOW_REPO,
      runId: 'run-global',
    });

    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    // Assert the FIRST PATCH, so a run that posts to the acted-on repository's
    // check run fails on the id it names rather than on a timeout.
    expect(mockChecksUpdate.mock.calls[0][0]).toMatchObject({
      check_run_id: GLOBAL_WORKFLOW_CHECK_ID,
      status: 'completed',
      conclusion: CheckRunConclusion.enum.failure,
    });
    expect(mockChecksUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: workflowCheckRunId }),
    );
  });

  it('completes its own job check run, not the acted-on repository one', async () => {
    const trackingStore = createGlobalOnlyTrackingStore();
    const reporter = new CheckRunReporter({ githubConfig, trackingStore: trackingStore as never });
    const { jobCheckRunId } = await seedPerRepositoryChecks(reporter);

    reporter.updateJobStatus({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobName: JOB,
      state: ExecutionJobStatus.enum.failed,
      installationId: 42,
      workflowRepoIdentifier: WORKFLOW_REPO,
      runId: 'run-global',
    });

    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    expect(mockChecksUpdate.mock.calls[0][0]).toMatchObject({
      check_run_id: GLOBAL_JOB_CHECK_ID,
      status: 'completed',
    });
    expect(mockChecksUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: jobCheckRunId }),
    );
  });

  it('reports step progress on its own job check run, not the acted-on repository one', async () => {
    const trackingStore = createGlobalOnlyTrackingStore();
    const reporter = new CheckRunReporter({ githubConfig, trackingStore: trackingStore as never });
    const { jobCheckRunId } = await seedPerRepositoryChecks(reporter);

    reporter.updateStepProgress({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobName: JOB,
      stepIndex: 0,
      stepName: 'build',
      state: ExecutionStepStatus.enum.running,
      installationId: 42,
      workflowRepoIdentifier: WORKFLOW_REPO,
      runId: 'run-global',
    });

    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    // Reopening a check run is the harm here: `in_progress` on the acted-on
    // repository's check would push a resolved check back to running.
    expect(mockChecksUpdate.mock.calls[0][0]).toMatchObject({
      check_run_id: GLOBAL_JOB_CHECK_ID,
      status: 'in_progress',
    });
    expect(mockChecksUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: jobCheckRunId }),
    );
  });

  it('leaves the acted-on repository check run resolvable after the global run is pruned', async () => {
    // `cleanupRun` evicts every key the run touched. A global run that resolved
    // the acted-on repository's key would register it as its own and evict that
    // run's check-run id and terminal latch on prune.
    const trackingStore = createGlobalOnlyTrackingStore();
    const reporter = new CheckRunReporter({ githubConfig, trackingStore: trackingStore as never });
    const { jobCheckRunId } = await seedPerRepositoryChecks(reporter);

    reporter.updateStepProgress({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobName: JOB,
      stepIndex: 0,
      stepName: 'build',
      state: ExecutionStepStatus.enum.running,
      installationId: 42,
      workflowRepoIdentifier: WORKFLOW_REPO,
      runId: 'run-global',
    });
    // A PATCH lands either way — its own check run, or the acted-on
    // repository's — so this wait closes the race on the key registration that
    // `cleanupRun` then evicts, without assuming which behaviour is under test.
    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    mockChecksUpdate.mockClear();

    reporter.cleanupRun('run-global');

    reporter.updateJobStatus({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobName: JOB,
      state: ExecutionJobStatus.enum.success,
      installationId: 42,
      runId: 'run-per-repo',
    });

    await vi.waitFor(() => {
      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          check_run_id: jobCheckRunId,
          status: 'completed',
          conclusion: CheckRunConclusion.enum.success,
        }),
      );
    });
  });
});

describe('stale check-run cleanup names the workflow repository', () => {
  // Both repositories define a workflow named `ci`, which is legal — they are
  // two lock files. Cleanup lists the acted-on repository's commit, so both
  // repositories' checks appear side by side in one response.
  const OWNER = 'acme';
  const REPO = 'app';
  const ACTED_ON = `${OWNER}/${REPO}`;
  const WORKFLOW_REPO = 'acme/ci-defs';
  const SHA = 'deadbeef';
  const WORKFLOW = 'ci';
  const JOB = 'test';
  const ROUTING_KEY = 'github:42';

  /** The acted-on repository's own check run — genuinely running, must survive. */
  const PER_REPO_CHECK_ID = 5100;
  /** The dead global run's check run — the one cleanup must time out. */
  const GLOBAL_CHECK_ID = 5200;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChecksListForRef.mockResolvedValue({ data: { check_runs: [] } });
  });

  /**
   * A listing carrying the named in-progress checks, in order. The acted-on
   * repository's unqualified check is listed FIRST wherever both appear, so an
   * implementation that matches unqualified names PATCHes it on the first call
   * — the assertion then fails on the id it names rather than on a timeout.
   */
  function listChecks(checks: Array<{ id: number; name: string }>): void {
    mockChecksListForRef.mockResolvedValue({
      data: {
        check_runs: checks.map((c) => ({ ...c, status: 'in_progress' })),
      },
    });
  }

  function cleanup(reporter: CheckRunReporter, workflowRepoIdentifier?: string): void {
    reporter.cleanupStaleCheckRuns({
      provider: 'github',
      routingKey: ROUTING_KEY,
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: [JOB],
      ...(workflowRepoIdentifier ? { workflowRepoIdentifier } : {}),
    });
  }

  it('times out the global run check, not the acted-on repository one', async () => {
    const reporter = new CheckRunReporter({ githubConfig });
    listChecks([
      { id: PER_REPO_CHECK_ID, name: `kici/${WORKFLOW}` },
      { id: GLOBAL_CHECK_ID, name: `kici/${WORKFLOW_REPO}/${WORKFLOW}` },
    ]);

    cleanup(reporter, WORKFLOW_REPO);

    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    expect(mockChecksUpdate.mock.calls[0][0]).toMatchObject({
      check_run_id: GLOBAL_CHECK_ID,
      status: 'completed',
      conclusion: CheckRunConclusion.enum.timed_out,
    });
    expect(mockChecksUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: PER_REPO_CHECK_ID }),
    );
  });

  it('times out the global run job check, not the acted-on repository one', async () => {
    const reporter = new CheckRunReporter({ githubConfig });
    listChecks([
      { id: PER_REPO_CHECK_ID, name: `kici/${WORKFLOW}/job/${JOB}` },
      { id: GLOBAL_CHECK_ID, name: `kici/${WORKFLOW_REPO}/${WORKFLOW}/job/${JOB}` },
    ]);

    cleanup(reporter, WORKFLOW_REPO);

    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    expect(mockChecksUpdate.mock.calls[0][0]).toMatchObject({ check_run_id: GLOBAL_CHECK_ID });
    expect(mockChecksUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: PER_REPO_CHECK_ID }),
    );
  });

  it('times out the global run setup check, not the acted-on repository one', async () => {
    const reporter = new CheckRunReporter({ githubConfig });
    listChecks([
      { id: PER_REPO_CHECK_ID, name: `kici/${WORKFLOW}/setup` },
      { id: GLOBAL_CHECK_ID, name: `kici/${WORKFLOW_REPO}/${WORKFLOW}/setup` },
    ]);

    cleanup(reporter, WORKFLOW_REPO);

    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    expect(mockChecksUpdate.mock.calls[0][0]).toMatchObject({ check_run_id: GLOBAL_CHECK_ID });
    expect(mockChecksUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: PER_REPO_CHECK_ID }),
    );
  });

  it('times out the unqualified check when the Platform sends no workflow repository', async () => {
    // An older Platform omits the field on EVERY run, ordinary ones included,
    // and an ordinary run is the overwhelming majority. Skipping on absence
    // would trade a rare, bounded wrong red for hung checks on every stale run
    // that Platform reports — so absence keeps naming the unqualified check.
    const reporter = new CheckRunReporter({ githubConfig });
    listChecks([{ id: PER_REPO_CHECK_ID, name: `kici/${WORKFLOW}` }]);

    cleanup(reporter);

    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    expect(mockChecksUpdate.mock.calls[0][0]).toMatchObject({
      check_run_id: PER_REPO_CHECK_ID,
      status: 'completed',
      conclusion: CheckRunConclusion.enum.timed_out,
    });
  });

  it('times out the unqualified check when the workflow repository is the acted-on one', async () => {
    // A global workflow firing on its own repository's event is not a
    // cross-repository run, so its check-run name never moved and cleanup must
    // still reach it. This is the same case as an absent field, which is why
    // the Platform never sends a value equal to the acted-on repository.
    const reporter = new CheckRunReporter({ githubConfig });
    listChecks([{ id: PER_REPO_CHECK_ID, name: `kici/${WORKFLOW}` }]);

    cleanup(reporter, ACTED_ON);

    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    expect(mockChecksUpdate.mock.calls[0][0]).toMatchObject({
      check_run_id: PER_REPO_CHECK_ID,
      conclusion: CheckRunConclusion.enum.timed_out,
    });
  });
});

describe('completing the check runs of a workflow that never dispatched', () => {
  const OWNER = 'acme';
  const REPO = 'app';
  const SHA = 'cafebabe';
  const WORKFLOW = 'CI';
  const RUN_ID = 'run-undispatched';

  beforeEach(() => {
    vi.clearAllMocks();
    checkRunIdCounter = 1000;
  });

  /** Post the queued checks exactly as `setupDispatchContext` does. */
  async function seedQueuedChecks(reporter: CheckRunReporter, jobNames: string[]): Promise<void> {
    await reporter.setPendingAwait({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames,
      installationId: 42,
      runId: RUN_ID,
    });
  }

  it('completes the workflow check and every per-job check with the given conclusion', async () => {
    const reporter = new CheckRunReporter({ githubConfig });
    await seedQueuedChecks(reporter, ['build', 'test']);
    // Non-vacuity: the seed really created three QUEUED checks, so the
    // completions below are turning those exact runs terminal.
    expect(mockChecksCreate).toHaveBeenCalledTimes(3);
    expect((mockChecksCreate.mock.calls[0][0] as any).status).toBe('queued');

    await reporter.completeUndispatchedCheckRuns({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: ['build', 'test'],
      installationId: 42,
      runId: RUN_ID,
      conclusion: CheckRunConclusion.enum.cancelled,
      summary: 'This run was cancelled before any job started.',
    });

    expect(mockChecksUpdate).toHaveBeenCalledTimes(3);
    const updates = mockChecksUpdate.mock.calls.map((c) => c[0] as any);
    for (const u of updates) {
      expect(u.status).toBe('completed');
      expect(u.conclusion).toBe(CheckRunConclusion.enum.cancelled);
      expect(u.output.summary).toContain('cancelled before any job started');
    }
    // The three ids the seed created, in the order `doSetPending` creates them.
    expect(updates.map((u) => u.check_run_id)).toEqual([1000, 1001, 1002]);
    expect(updates.map((u) => u.output.title)).toEqual([
      `KiCI: ${WORKFLOW}`,
      `KiCI: ${WORKFLOW}/build`,
      `KiCI: ${WORKFLOW}/test`,
    ]);
  });

  it('leaves the build check alone', async () => {
    const reporter = new CheckRunReporter({ githubConfig });
    await seedQueuedChecks(reporter, []);
    reporter.setBuildPending({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      installationId: 42,
      runId: RUN_ID,
    });
    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });
    // Control: the build check exists and is resolvable, so its absence from
    // the updates below is a decision and not a lookup miss.
    expect((mockChecksCreate.mock.calls[1][0] as any).name).toBe(`kici/${WORKFLOW}/setup`);

    await reporter.completeUndispatchedCheckRuns({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: [],
      installationId: 42,
      runId: RUN_ID,
      conclusion: CheckRunConclusion.enum.timed_out,
      summary: 'The approval window elapsed.',
    });

    expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    expect((mockChecksUpdate.mock.calls[0][0] as any).check_run_id).toBe(1000);
  });

  it('resolves an L1-cached id without reading its tracking row', async () => {
    // The mechanism behind excluding `kici/<workflow>/setup` from the target
    // set. The terminal latch is rehydrated from `terminal_sent_at` only inside
    // the store read, and this asserts that read does not happen on an L1 hit —
    // so a build check `setBuildComplete` completed a moment ago (which stamps
    // the row but adds nothing to the in-process set) resolves here with no
    // latch, and completing it again would overwrite its real conclusion.
    const trackingStore = createTrackingStoreStub();
    const reporter = new CheckRunReporter({ githubConfig, trackingStore: trackingStore as never });
    await seedQueuedChecks(reporter, []);
    trackingStore.getState.mockClear();

    await reporter.completeUndispatchedCheckRuns({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: [],
      installationId: 42,
      runId: RUN_ID,
      conclusion: CheckRunConclusion.enum.cancelled,
      summary: 'cancelled',
    });

    // It resolved and completed the check — so the store was genuinely not
    // consulted, rather than the whole call being skipped.
    expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    expect(trackingStore.getState).not.toHaveBeenCalled();
  });

  it('skips a check run it cannot resolve an id for', async () => {
    // No seed: nothing was ever created, so nothing is resolvable.
    const reporter = new CheckRunReporter({ githubConfig });
    await reporter.completeUndispatchedCheckRuns({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: ['build'],
      installationId: 42,
      runId: RUN_ID,
      conclusion: CheckRunConclusion.enum.cancelled,
      summary: 'nothing to close',
    });
    expect(mockChecksUpdate).not.toHaveBeenCalled();
  });

  it('does not reopen a check this reporter already reported terminal', async () => {
    const reporter = new CheckRunReporter({ githubConfig });
    await seedQueuedChecks(reporter, ['build']);
    reporter.updateJobStatus({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobName: 'build',
      state: ExecutionJobStatus.enum.success,
      installationId: 42,
      runId: RUN_ID,
    });
    await vi.waitFor(() => {
      expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    });

    await reporter.completeUndispatchedCheckRuns({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: ['build'],
      installationId: 42,
      runId: RUN_ID,
      conclusion: CheckRunConclusion.enum.cancelled,
      summary: 'This run was cancelled before any job started.',
    });

    // Only the workflow check moved; the already-terminal job check did not.
    expect(mockChecksUpdate).toHaveBeenCalledTimes(2);
    expect((mockChecksUpdate.mock.calls[1][0] as any).check_run_id).toBe(1000);
  });

  it('qualifies the names for a cross-repository global run', async () => {
    const reporter = new CheckRunReporter({ githubConfig });
    await reporter.setPendingAwait({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      workflowRepoIdentifier: 'acme/ci-defs',
      jobNames: ['build'],
      installationId: 42,
      runId: RUN_ID,
    });
    expect((mockChecksCreate.mock.calls[0][0] as any).name).toBe(`kici/acme/ci-defs/${WORKFLOW}`);

    await reporter.completeUndispatchedCheckRuns({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      workflowRepoIdentifier: 'acme/ci-defs',
      jobNames: ['build'],
      installationId: 42,
      runId: RUN_ID,
      conclusion: CheckRunConclusion.enum.cancelled,
      summary: 'cancelled',
    });

    expect(mockChecksUpdate).toHaveBeenCalledTimes(2);
    expect((mockChecksUpdate.mock.calls[0][0] as any).output.title).toBe(
      `KiCI: acme/ci-defs/${WORKFLOW}`,
    );
  });
});
