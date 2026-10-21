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
import { StepLogBuffer } from './step-log-buffer.js';
import { GithubCheckConclusion } from './github-check-conclusion.js';

vi.mock('../metrics/prometheus.js', () => ({
  githubCheckRunTotal: { add: vi.fn() },
}));

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

// App-level Octokit for stale check-run cleanup: the one path that lists check runs from the
// GitHub API instead of the in-memory id map, so it resolves the installation as the App.
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
const ROUTING_KEY = 'github:12345';

/** A registry whose GitHub bundle at `routingKey` carries `githubConfig`. */
function githubRegistry(routingKey: string = ROUTING_KEY): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.registerByRoutingKey(routingKey, {
    normalizer: {} as never,
    cloneTokenProvider: { provider: 'github', getAppConfig: () => githubConfig } as never,
  });
  return registry;
}

type PendingOptions = Parameters<CheckRunReporter['setPending']>[0];
type JobStatusOptions = Parameters<CheckRunReporter['updateJobStatus']>[0];

/** The `setPending` argument the cases start from: job `test` of workflow `CI`. */
function pending(overrides: Partial<PendingOptions> = {}): PendingOptions {
  return {
    provider: 'github',
    owner: 'myorg',
    repo: 'myrepo',
    sha: 'abc123',
    workflowName: 'CI',
    jobNames: ['test'],
    installationId: 42,
    routingKey: ROUTING_KEY,
    ...overrides,
  };
}

/** The `updateJobStatus` argument the cases start from: job `test` of workflow `CI` failed. */
function jobUpdate(overrides: Partial<JobStatusOptions> = {}): JobStatusOptions {
  return {
    provider: 'github',
    owner: 'myorg',
    repo: 'myrepo',
    sha: 'abc123',
    workflowName: 'CI',
    jobName: 'test',
    state: ExecutionJobStatus.enum.failed,
    installationId: 42,
    routingKey: ROUTING_KEY,
    ...overrides,
  };
}

/**
 * An all-stub `CheckRunTrackingStore` with the full method surface: a missing method would
 * throw into a swallowing catch on write-through and read as a passing test.
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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending({ workflowName: 'build', jobNames: ['test', 'lint'] }));

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(3);
      });

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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending({ provider: 'gitlab', workflowName: 'build' }));

      await new Promise((r) => setTimeout(r, 50));

      expect(mockChecksCreate).not.toHaveBeenCalled();
    });

    it('skips when no provider registry is configured', async () => {
      const reporter = new CheckRunReporter({});

      reporter.setPending(pending({ workflowName: 'build' }));

      await new Promise((r) => setTimeout(r, 50));

      expect(mockChecksCreate).not.toHaveBeenCalled();
    });

    it('skips when installationId is missing', async () => {
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending());

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus(jobUpdate({ state: ExecutionJobStatus.enum.success }));

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

    describe('a skipped job', () => {
      async function completeSkipped(data: Record<string, unknown>, description?: string) {
        const reporter = new CheckRunReporter({
          providerRegistry: githubRegistry(),
          stepLogBuffer: new StepLogBuffer(),
        });
        reporter.setPending(pending());
        await vi.waitFor(() => {
          expect(mockChecksCreate).toHaveBeenCalledTimes(2);
        });
        reporter.updateJobStatus(
          jobUpdate({
            state: ExecutionJobStatus.enum.skipped,
            data,
            ...(description !== undefined && { description }),
          }),
        );
        await vi.waitFor(() => {
          expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
        });
        return mockChecksUpdate.mock.calls[0][0] as {
          conclusion: string;
          output: { summary: string };
        };
      }

      it('a rule skip reads skipped, names the rule and shows the skipped step', async () => {
        const update = await completeSkipped({
          stepResults: [{ name: 'test', status: 'skipped', durationMs: 0 }],
          error: "rule 'push to main' returned false",
        });
        expect(update.conclusion).toBe(GithubCheckConclusion.enum.skipped);
        expect(update.output.summary).toMatch(
          /^\*\*Job 'test' skipped\*\* — rule 'push to main' returned false/,
        );
        expect(update.output.summary).toContain('| test | \u23ED skipped |');
        expect(update.output.summary).not.toContain('failed');
      });

      it('an orchestrator-set skip keeps its description', async () => {
        const update = await completeSkipped(
          { error: 'upstream_unmet: build (failed)' },
          'Job skipped: upstream_unmet: build (failed)',
        );
        expect(update.conclusion).toBe(GithubCheckConclusion.enum.skipped);
        expect(update.output.summary).toContain('Job skipped: upstream_unmet: build (failed)');
      });

      it('a non-string reason renders the headline without one', async () => {
        const update = await completeSkipped({
          stepResults: [{ name: 'test', status: 'skipped', durationMs: 0 }],
          error: 42,
        });
        expect(update.output.summary.split('\n')[0]).toBe("**Job 'test' skipped**");
      });
    });

    /**
     * The trust policy let the run proceed, so no security check was posted and the job fails
     * on something the run was never given; this check and the `kici/<workflow>` roll-up are
     * where the contributor can be told why.
     */
    async function completeJobWithPosture(over: {
      trustTier?: string;
      lockFileSource?: string;
    }): Promise<string> {
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
      reporter.setPending(pending());
      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus(jobUpdate(over));

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
      // Failure mode: a step status arriving after completion schedules a fresh debounce
      // timer that PATCHes the check run back open (`in_progress` with `conclusion: failure`),
      // so completion has to be a one-way latch.
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending());
      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus(jobUpdate());
      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });
      expect(mockChecksUpdate).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );

      // Without the latch, this late step takes the "first running step" branch and PATCHes
      // `in_progress` immediately.
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
        routingKey: ROUTING_KEY,
      });

      // Drain the queue instead of sleeping: the suppressed path is a few
      // awaited promises, and a fixed sleep gets shorter than the work on load.
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));

      expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      expect(mockChecksUpdate.mock.calls.some((c) => c[0]?.status === 'in_progress')).toBe(false);
    });

    it('maps failed to failure conclusion', async () => {
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending());

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus(jobUpdate());

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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending());

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus(jobUpdate({ state: ExecutionJobStatus.enum.cancelled }));

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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending());

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });

      reporter.updateJobStatus(jobUpdate({ description: 'Step "Build" failed with exit code 1' }));

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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.updateJobStatus(jobUpdate({ state: ExecutionJobStatus.enum.success }));

      await new Promise((r) => setTimeout(r, 50));

      expect(mockChecksUpdate).not.toHaveBeenCalled();
    });

    it('handles non-GitHub provider gracefully', async () => {
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.updateJobStatus(
        jobUpdate({ provider: 'bitbucket', state: ExecutionJobStatus.enum.success }),
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(mockChecksUpdate).not.toHaveBeenCalled();
    });
  });

  describe('the reduced-privilege note and the summary byte cap', () => {
    it('keeps a note-led job summary under the API cap', async () => {
      // `buildCheckRunSummary` spends the byte budget on its own, so a note added afterwards
      // could push the update over the cap; GitHub rejects it and the check run stays
      // unresolved, worse than a shorter log excerpt. check-run-summary.test.ts pins the
      // budget; this pins the invariant end to end. The empty log buffer still takes the
      // rich-summary branch.
      const reporter = new CheckRunReporter({
        providerRegistry: githubRegistry(),
        stepLogBuffer: { getLastLines: () => undefined } as unknown as never,
      });
      reporter.setPending(pending());
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
        routingKey: ROUTING_KEY,
        runIdForLogs: 'run-1',
        jobId: 'job-1',
        data: {
          // ~30 KB of step errors: past the note's size, inside the cap so the builder
          // returns a real summary, not its minimal fallback.
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
      // Non-vacuity: the body is at the scale the budget governs and carries the note.
      expect(Buffer.byteLength(summary, 'utf-8')).toBeGreaterThan(10_000);
      expect(summary.startsWith(REDUCED_PRIVILEGE_MARKER)).toBe(true);
      expect(Buffer.byteLength(summary, 'utf-8')).toBeLessThanOrEqual(SUMMARY_BYTE_LIMIT);
    });

    it('leads the workflow roll-up check with the note too', async () => {
      // The roll-up is the check a branch-protection rule usually requires, so
      // a contributor may read only this one.
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
      reporter.setPending(pending());
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
        routingKey: ROUTING_KEY,
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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
      reporter.setPending(pending());
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
        routingKey: ROUTING_KEY,
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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending());

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
        routingKey: ROUTING_KEY,
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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending());

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
        routingKey: ROUTING_KEY,
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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending());

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
        routingKey: ROUTING_KEY,
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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending());

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
        routingKey: ROUTING_KEY,
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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.success,
        installationId: 42,
        routingKey: ROUTING_KEY,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(mockChecksUpdate).not.toHaveBeenCalled();
    });
  });

  describe('terminal check-run updates record that they were sent', () => {
    /** Every method resolves, so a write-through never throws for an unrelated reason. */
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
      reporter.setPending(pending());
      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(2);
      });
    }

    it('drops an in-flight in_progress write once the job has completed (no reopened check run)', async () => {
      // Reproduces the `status: in_progress, conclusion: <terminal>` state seen on a real
      // failed-job check run: an in_progress write passes its `terminalSent` guard, then the
      // job completes (latch + `completed` PATCH) while that write awaits its tracking-store
      // persist. updateCheckRun's final latch re-check must drop the obsolete PATCH.
      let releaseStepPersist: () => void = () => {};
      const stepPersistGate = new Promise<void>((resolve) => {
        releaseStepPersist = resolve;
      });
      const trackingStore = makeTrackingStore();
      // Hold the in_progress path parked at its persist await, past the guard.
      trackingStore.setStepProgress.mockImplementation(() => stepPersistGate);

      const reporter = new CheckRunReporter({
        providerRegistry: githubRegistry(),
        trackingStore: trackingStore as never,
      });
      await seedWorkflowCheckRun(reporter);

      // 1. The in_progress write passes its terminalSent guard and parks at setStepProgress.
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
        routingKey: ROUTING_KEY,
        runId: 'run-1',
      });

      // 2. The job fails meanwhile: latches the key and PATCHes `completed`/`failure`.
      reporter.updateJobStatus(jobUpdate({ runId: 'run-1' }));
      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'completed', conclusion: 'failure' }),
        );
      });

      // 3. On release, updateCheckRun's re-check must see the latch and drop the PATCH.
      releaseStepPersist();
      await new Promise((r) => setTimeout(r, 50));

      const inProgressWrites = mockChecksUpdate.mock.calls.filter(
        (c) => (c[0] as { status?: string }).status === 'in_progress',
      );
      expect(
        inProgressWrites,
        'the in-flight in_progress write must be dropped after completion',
      ).toHaveLength(0);
      expect(mockChecksUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', conclusion: 'failure' }),
      );
    });

    it('serializes PATCHes per key so a live in_progress write cannot land after completion', async () => {
      // updateCheckRun's latch re-check runs BEFORE the network PATCH, so an in_progress
      // PATCH already awaiting GitHub can land after `completed` and reopen the check run
      // (`{ status: in_progress, conclusion: failure }`, seen on a real failed job). The
      // previous test parks before the PATCH; this one parks mid-PATCH, which only per-key
      // serialization closes: `completed` must wait for the in-flight in_progress PATCH.
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
        providerRegistry: githubRegistry(),
        trackingStore: trackingStore as never,
      });
      await seedWorkflowCheckRun(reporter);

      // 1. The in_progress PATCH parks at octokit.checks.update, holding the per-key lock.
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
        routingKey: ROUTING_KEY,
        runId: 'run-1',
      });
      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'in_progress' }),
        );
      });

      // 2. The job fails meanwhile; its PATCH must wait for the in_progress one to settle.
      reporter.updateJobStatus(jobUpdate({ runId: 'run-1' }));
      await new Promise((r) => setTimeout(r, 50));

      // Discriminator: without per-key serialization both PATCHes race at GitHub.
      const completedIssuedWhileInFlight = mockChecksUpdate.mock.calls.some(
        (c) => (c[0] as { status?: string }).status === 'completed',
      );
      expect(
        completedIssuedWhileInFlight,
        'the completed PATCH must not be issued while an in_progress PATCH is still in flight for the same key',
      ).toBe(false);

      // 3. On release, completion proceeds and the terminal state is the last write.
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
        providerRegistry: githubRegistry(),
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
        routingKey: ROUTING_KEY,
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
        providerRegistry: githubRegistry(),
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
        routingKey: ROUTING_KEY,
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
        providerRegistry: githubRegistry(),
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
        routingKey: ROUTING_KEY,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });
      // Drain the queue rather than sleep: the rest of this path is at most one awaited
      // promise, and a fixed sleep gets shorter than the work under load.
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(trackingStore.markTerminalSent).not.toHaveBeenCalled();
    });

    it('still completes the GitHub update when the marker write fails', async () => {
      const trackingStore = makeTrackingStore();
      trackingStore.markTerminalSent.mockRejectedValue(new Error('db down'));
      const reporter = new CheckRunReporter({
        providerRegistry: githubRegistry(),
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
        routingKey: ROUTING_KEY,
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
      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending({ jobNames: ['test', 'build'] }));

      await vi.waitFor(() => {
        expect(mockChecksCreate).toHaveBeenCalledTimes(3); // workflow + 2 jobs
      });

      reporter.updateJobStatus(jobUpdate({ state: ExecutionJobStatus.enum.success }));

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
      });

      reporter.updateJobStatus(jobUpdate({ jobName: 'build' }));

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(2);
      });

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'CI',
        overallStatus: ExecutionJobStatus.enum.failed,
        installationId: 42,
        routingKey: ROUTING_KEY,
      });

      await vi.waitFor(() => {
        expect(mockChecksUpdate).toHaveBeenCalledTimes(3);
      });

      // Ids: workflow=1000, test=1001, build=1002.
      const updateCalls = mockChecksUpdate.mock.calls;

      expect(updateCalls[0][0].check_run_id).toBe(1001);
      expect(updateCalls[0][0].conclusion).toBe(CheckRunConclusion.enum.success);

      expect(updateCalls[1][0].check_run_id).toBe(1002);
      expect(updateCalls[1][0].conclusion).toBe('failure');

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

      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending());

      await new Promise((r) => setTimeout(r, 100));

      // The error is caught internally.
      expect(true).toBe(true);
    });

    it('does not propagate API errors (fire-and-forget)', async () => {
      mockChecksCreate.mockRejectedValueOnce(new Error('Network error'));

      const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

      reporter.setPending(pending());

      await new Promise((r) => setTimeout(r, 100));

      expect(true).toBe(true);
    });
  });

  describe('tracking-store interaction', () => {
    it('records the runId when persisting a freshly created check-run ID', async () => {
      const trackingStore = createTrackingStoreStub();
      const reporter = new CheckRunReporter({
        providerRegistry: githubRegistry(),
        trackingStore: trackingStore as never,
      });

      reporter.setPending(pending({ workflowName: 'build', runId: 'run-xyz' }));

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
        providerRegistry: githubRegistry(),
        trackingStore: trackingStore as never,
      });

      reporter.setPending(pending({ workflowName: 'build', runId: 'run-xyz' }));
      await vi.waitFor(() => expect(trackingStore.setCheckRunId).toHaveBeenCalled());

      reporter.cleanupRun('run-xyz');

      expect(trackingStore.deleteByRunId).not.toHaveBeenCalled();
    });

    /**
     * Tracking-store fake with real row state, so a load-through after a delete genuinely
     * misses; a no-op delete would pass the load-through assertion whether or not
     * `cleanupRun` deleted.
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
      // Reads the same row as `getCheckRunId`, as the real store does through `selectRow`.
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
      // Positive control for the load-through pin below: the fake can detect a delete.
      const { store, rows } = createStatefulTrackingStore();
      await store.setCheckRunId({ checkName: 'kici/build' } as never, 4242, 'run-xyz');
      expect(await store.getCheckRunId({ checkName: 'kici/build' } as never)).toBe(4242);

      expect(await store.deleteByRunId('run-xyz')).toBe(1);

      expect(rows.size).toBe(0);
      expect(await store.getCheckRunId({ checkName: 'kici/build' } as never)).toBeUndefined();
    });

    it('still resolves a check-run ID from the store after cleanupRun evicted L1', async () => {
      // The prune leaves the row so a terminal PATCH landing afterwards still finds its
      // check-run ID; without it the check run stays unresolved on the commit forever.
      const { store: trackingStore } = createStatefulTrackingStore();
      const reporter = new CheckRunReporter({
        providerRegistry: githubRegistry(),
        trackingStore: trackingStore as never,
      });

      reporter.setPending(pending({ workflowName: 'build', runId: 'run-xyz' }));
      await vi.waitFor(() => expect(trackingStore.setCheckRunId).toHaveBeenCalledTimes(2));
      const workflowCheckRunId = await trackingStore.getCheckRunId({
        checkName: 'kici/build',
      } as never);
      expect(workflowCheckRunId).toEqual(expect.any(Number));

      reporter.cleanupRun('run-xyz');
      // L1 is empty, so the update loads through to the store.

      reporter.updateWorkflowStatus({
        provider: 'github',
        owner: 'myorg',
        repo: 'myrepo',
        sha: 'abc123',
        workflowName: 'build',
        overallStatus: ExecutionJobStatus.enum.success,
        installationId: 42,
        routingKey: ROUTING_KEY,
        runId: 'run-xyz',
      });

      await vi.waitFor(() => {
        // `getState`: the read-through pulls the whole row to rehydrate the terminal latch.
        // `getCheckRunId` would pass on the test's own direct call above.
        expect(trackingStore.getState).toHaveBeenCalledWith(
          expect.objectContaining({ checkName: 'kici/build' }),
        );
        expect(mockChecksUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ check_run_id: workflowCheckRunId, status: 'completed' }),
        );
      });
    });

    it('does not reopen a completed job check run when a step arrives after cleanupRun', async () => {
      // The prune keeps the `check_run_tracking` row so a late update resolves its id. If
      // the id comes back from the row without the terminal latch, the late step PATCHes
      // the completed check run back open (`in_progress` with `conclusion: failure`).
      const { store: trackingStore } = createStatefulTrackingStore();
      const reporter = new CheckRunReporter({
        providerRegistry: githubRegistry(),
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
        routingKey: ROUTING_KEY,
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

      // The prune drops every in-memory entry, latch included; only the row remembers.
      reporter.cleanupRun('run-xyz');

      reporter.updateStepProgress({
        ...job,
        stepIndex: 0,
        stepName: 'late-step',
        state: ExecutionStepStatus.enum.running,
      });

      // Drain rather than sleep: a fixed sleep gets shorter than the work under load.
      for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));

      expect(mockChecksUpdate).not.toHaveBeenCalled();
    });

    it('still publishes step progress after cleanupRun when the job never completed', async () => {
      // Positive control for the absence pin above: a reporter that stopped publishing
      // progress after any prune would pass that test.
      const { store: trackingStore } = createStatefulTrackingStore();
      const reporter = new CheckRunReporter({
        providerRegistry: githubRegistry(),
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
        routingKey: ROUTING_KEY,
        runId: 'run-xyz',
      };

      reporter.setPending({ ...job, jobNames: ['test'] });
      await vi.waitFor(() => expect(trackingStore.setCheckRunId).toHaveBeenCalledTimes(2));
      mockChecksUpdate.mockClear();

      // No terminal update was sent, so the row has no `terminal_sent_at`.
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

    reporter.setPending(pending({ workflowName: 'build', routingKey: 'github:99999' }));

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

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

    reporter.setPending(
      pending({
        owner: 'org1',
        repo: 'repo1',
        sha: 'sha1',
        installationId: 100,
        routingKey: 'github:11111',
      }),
    );

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    reporter.setPending(
      pending({
        owner: 'org2',
        repo: 'repo2',
        sha: 'sha2',
        jobNames: ['lint'],
        installationId: 200,
        routingKey: 'github:22222',
      }),
    );

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(4);
    });

    // One octokit per setPending call, reused for all its check runs.
    const calls = mockedCreateOctokit.mock.calls;
    expect(calls).toHaveLength(2);

    expect(calls[0][0]).toEqual(app1Config);
    expect(calls[0][1]).toBe(100);

    expect(calls[1][0]).toEqual(app2Config);
    expect(calls[1][1]).toBe(200);
  });

  it('skips when the routing key has no registered bundle', async () => {
    // fails-when: an unknown routing key borrows another App's credentials.
    const registry = new ProviderRegistry();
    registry.registerByRoutingKey('github:other', {
      normalizer: {} as never,
      cloneTokenProvider: { provider: 'github', getAppConfig: () => githubConfig } as never,
    });
    const reporter = new CheckRunReporter({ providerRegistry: registry });

    reporter.setPending(pending({ workflowName: 'build', routingKey: 'github:unknown' }));

    await new Promise((r) => setTimeout(r, 50));
    expect(mockChecksCreate).not.toHaveBeenCalled();
  });

  it('skips when no config is resolvable (no registry, no githubConfig)', async () => {
    const reporter = new CheckRunReporter({});

    reporter.setPending(pending({ workflowName: 'build', routingKey: 'github:12345' }));

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

  it('handles stepResults with failed status', () => {
    const result = buildJobFailureDescription({
      stepResults: [{ name: 'compile', status: 'failed', error: 'OOM killed' }],
    });
    expect(result).toBe("Step 'compile' failed: OOM killed");
  });

  it('does not read the retired error step status as a failure', () => {
    // fails-when: the `error` alias reader survives in buildJobFailureDescription.
    const result = buildJobFailureDescription({
      stepResults: [{ name: 'compile', status: 'error', error: 'OOM killed' }],
    });
    expect(result).toBe('Job failed');
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
      providerRegistry: githubRegistry(),
      dashboardUrl: 'https://example.test/kici/dashboard',
      getOrgPublicAlias: () => ALIAS,
    });

    reporter.setPending(pending({ workflowName: 'build', runId: RUN_ID }));

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

  /** The details_url of the first check run a reporter built from `deps` creates. */
  async function firstDetailsUrl(
    deps: Omit<ConstructorParameters<typeof CheckRunReporter>[0], 'providerRegistry'>,
  ): Promise<string | undefined> {
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry(), ...deps });
    reporter.setPending(pending({ runId: RUN_ID }));
    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });
    return (mockChecksCreate.mock.calls[0][0] as { details_url?: string }).details_url;
  }

  it('strips a trailing slash on dashboardUrl', async () => {
    expect(
      await firstDetailsUrl({
        dashboardUrl: 'https://example.test/kici/dashboard/',
        getOrgPublicAlias: () => ALIAS,
      }),
    ).toBe(`https://example.test/kici/dashboard/r/orgs/${ALIAS}/runs/${RUN_ID}`);
  });

  it('omits details_url with neither KICI_DASHBOARD_URL nor a Platform-supplied URL (independent mode)', async () => {
    expect(await firstDetailsUrl({ getOrgPublicAlias: () => ALIAS })).toBeUndefined();
  });

  // fails-when: buildDetailsUrl reads only KICI_DASHBOARD_URL, so a Platform-attached
  //   orchestrator with no override posts check runs GitHub links to the App homepage.
  it('falls back to the Platform-supplied dashboard URL on workflow and job check runs', async () => {
    const reporter = new CheckRunReporter({
      providerRegistry: githubRegistry(),
      getOrgPublicAlias: () => ALIAS,
      getPlatformDashboardUrl: () => 'https://app.test',
    });

    reporter.setPending(pending({ runId: RUN_ID }));

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });
    const created = mockChecksCreate.mock.calls.map(
      (c) => c[0] as { name: string; details_url?: string },
    );
    // The workflow check and the job check both link to the run page.
    expect(created.some((c) => c.name.includes('/job/'))).toBe(true);
    for (const call of created) {
      expect(call.details_url).toBe(`https://app.test/r/orgs/${ALIAS}/runs/${RUN_ID}`);
    }

    reporter.updateJobStatus(jobUpdate({ state: ExecutionJobStatus.enum.success, runId: RUN_ID }));
    await vi.waitFor(() => {
      expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    });
    expect((mockChecksUpdate.mock.calls[0][0] as any).details_url).toBe(
      `https://app.test/r/orgs/${ALIAS}/runs/${RUN_ID}`,
    );
  });

  // breaks-if-wrong: the Platform URL wins over an explicit KICI_DASHBOARD_URL.
  it('prefers KICI_DASHBOARD_URL over the Platform-supplied URL', async () => {
    expect(
      await firstDetailsUrl({
        dashboardUrl: 'https://example.test/kici/dashboard',
        getOrgPublicAlias: () => ALIAS,
        getPlatformDashboardUrl: () => 'https://app.test',
      }),
    ).toBe(`https://example.test/kici/dashboard/r/orgs/${ALIAS}/runs/${RUN_ID}`);
  });

  // fails-when: the precedence uses ?? — an empty KICI_DASHBOARD_URL= then wins and
  //   every check run loses its Details link.
  it('treats an empty KICI_DASHBOARD_URL as unset', async () => {
    expect(
      await firstDetailsUrl({
        dashboardUrl: '',
        getOrgPublicAlias: () => ALIAS,
        getPlatformDashboardUrl: () => 'https://app.test',
      }),
    ).toBe(`https://app.test/r/orgs/${ALIAS}/runs/${RUN_ID}`);
  });

  it('omits details_url when alias resolver returns undefined', async () => {
    expect(
      await firstDetailsUrl({
        dashboardUrl: 'https://example.test/kici/dashboard',
        getOrgPublicAlias: () => undefined,
      }),
    ).toBeUndefined();
  });

  it('omits details_url when no real runId is available (N/A sentinel)', async () => {
    const reporter = new CheckRunReporter({
      providerRegistry: githubRegistry(),
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
      routingKey: ROUTING_KEY,
      // No runId, no AsyncLocalStorage context — resolveTraceIds yields 'N/A'.
    });

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    expect((mockChecksCreate.mock.calls[0][0] as any).details_url).toBeUndefined();
  });

  it('propagates details_url through job-completion update', async () => {
    const reporter = new CheckRunReporter({
      providerRegistry: githubRegistry(),
      dashboardUrl: 'https://example.test/kici/dashboard',
      getOrgPublicAlias: () => ALIAS,
    });

    reporter.setPending(pending({ runId: RUN_ID }));

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    reporter.updateJobStatus(jobUpdate({ state: ExecutionJobStatus.enum.success, runId: RUN_ID }));

    await vi.waitFor(() => {
      expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    });

    const expectedUrl = `https://example.test/kici/dashboard/r/orgs/${ALIAS}/runs/${RUN_ID}`;
    expect((mockChecksUpdate.mock.calls[0][0] as any).details_url).toBe(expectedUrl);
  });

  it('updateJobStatus emits details_url with explicit runId outside ALS frame', async () => {
    // Agent WS handlers in app.ts call updateJobStatus outside a request-context ALS frame,
    // so the reporter must accept an explicit runId rather than rely on getRequestContext().
    const reporter = new CheckRunReporter({
      providerRegistry: githubRegistry(),
      dashboardUrl: 'https://example.test/kici/dashboard',
      getOrgPublicAlias: () => ALIAS,
    });

    reporter.setPending(pending({ runId: RUN_ID }));

    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });

    reporter.updateJobStatus(jobUpdate({ runId: RUN_ID }));

    await vi.waitFor(() => {
      expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    });
    const expectedUrl = `https://example.test/kici/dashboard/r/orgs/${ALIAS}/runs/${RUN_ID}`;
    expect((mockChecksUpdate.mock.calls[0][0] as any).details_url).toBe(expectedUrl);
  });

  it('updateWorkflowStatus emits details_url with explicit runId outside ALS frame', async () => {
    // orchestrator-core's onExecutionComplete fires outside any request-context ALS frame,
    // so the workflow-level completion path must accept an explicit runId.
    const reporter = new CheckRunReporter({
      providerRegistry: githubRegistry(),
      dashboardUrl: 'https://example.test/kici/dashboard',
      getOrgPublicAlias: () => ALIAS,
    });

    // setPendingAwait caches the id before updateWorkflowStatus looks it up (no race).
    await reporter.setPendingAwait({
      provider: 'github',
      owner: 'myorg',
      repo: 'myrepo',
      sha: 'abc123',
      workflowName: 'CI',
      jobNames: [],
      installationId: 42,
      routingKey: ROUTING_KEY,
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
      routingKey: ROUTING_KEY,
      runId: RUN_ID,
    });

    await vi.waitFor(() => {
      expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    });
    const expectedUrl = `https://example.test/kici/dashboard/r/orgs/${ALIAS}/runs/${RUN_ID}`;
    expect((mockChecksUpdate.mock.calls[0][0] as any).details_url).toBe(expectedUrl);
  });

  it.each([
    {
      setter: 'setOrgPublicAliasResolver',
      deps: { dashboardUrl: 'https://example.test/kici/dashboard' },
      bind: (r: CheckRunReporter) => r.setOrgPublicAliasResolver(() => ALIAS),
      expected: `https://example.test/kici/dashboard/r/orgs/${ALIAS}/runs/${RUN_ID}`,
    },
    {
      setter: 'setPlatformDashboardUrlResolver',
      deps: { getOrgPublicAlias: () => ALIAS },
      bind: (r: CheckRunReporter) => r.setPlatformDashboardUrlResolver(() => 'https://app.test'),
      expected: `https://app.test/r/orgs/${ALIAS}/runs/${RUN_ID}`,
    },
  ])('$setter late-binds the resolver', async ({ deps, bind, expected }) => {
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry(), ...deps });
    const oneCheck = (key: string) =>
      pending({
        owner: key,
        repo: key,
        sha: `${key}1`,
        workflowName: `w${key}`,
        jobNames: [],
        runId: RUN_ID,
      });
    reporter.setPending(oneCheck('a'));
    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(1);
    });
    expect((mockChecksCreate.mock.calls[0][0] as any).details_url).toBeUndefined();

    bind(reporter);
    reporter.setPending(oneCheck('b'));
    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });
    expect((mockChecksCreate.mock.calls[1][0] as any).details_url).toBe(expected);
  });
});

describe('check-run conclusion mappers cover every terminal job status', () => {
  type Mapper = (s: string, d?: string) => { conclusion: string; description: string };
  const mappers = ['mapBuildConclusion', 'mapJobConclusion', 'mapWorkflowConclusion'] as const;

  const call = (mapper: string, status: string): { conclusion: string; description: string } => {
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
    return (reporter as unknown as Record<string, Mapper>)[mapper](status);
  };

  /**
   * The conclusion each terminal status must map to. A `toBeDefined()` loop would pass on the
   * catch-all `default` arm (`failure` plus "unrecognised status") for any input; pinning the
   * conclusion fails every other row, and the description assertion below catches the rest.
   */
  const EXPECTED_CONCLUSION: Record<string, string> = {
    [ExecutionJobStatus.enum.success]: CheckRunConclusion.enum.success,
    [ExecutionJobStatus.enum.failed]: CheckRunConclusion.enum.failure,
    [ExecutionJobStatus.enum.cancelled]: CheckRunConclusion.enum.cancelled,
    // fails-when: a skipped job maps to cancelled, which blocks a required check.
    [ExecutionJobStatus.enum.skipped]: GithubCheckConclusion.enum.skipped,
    [ExecutionJobStatus.enum.timed_out_stale]: CheckRunConclusion.enum.timed_out,
    [ExecutionJobStatus.enum.drift_dropped]: CheckRunConclusion.enum.failure,
    [ExecutionJobStatus.enum.unroutable]: CheckRunConclusion.enum.failure,
  };

  it('names an expected conclusion for every terminal status', () => {
    // A terminal status added to the engine without a row here would skip its assertion.
    expect(Object.keys(EXPECTED_CONCLUSION).sort()).toEqual([...TERMINAL_JOB_STATES].sort());
  });

  for (const mapper of mappers) {
    for (const status of TERMINAL_JOB_STATES) {
      it(`${mapper} maps ${status} to its expected conclusion`, () => {
        const result = call(mapper, status);
        expect(result).toBeDefined();
        expect(result.conclusion).toBe(EXPECTED_CONCLUSION[status]);
        // A status that reached the "unrecognised status" default arm must not pass.
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
  // The acted-on repository (where a global workflow's run is attributed) and the defining
  // repository both define a workflow named `ci`, which is legal: they are two lock files.
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
   * A tracking store that resolves ONLY the global run's qualified keys, so each test asserts
   * WHICH check run was PATCHed instead of a wall-clock "nothing happened", which passes for
   * free on a loaded executor.
   *
   * Undefined for the acted-on repository's unqualified keys models the documented cache-only
   * fallback (a failed write-through leaves L1 the only copy), isolating the L1 state that
   * `cleanupRun` evicts.
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
      // The read-through reads the whole row; the real store answers both from one `selectRow`.
      getState: vi.fn(async (key: { checkName: string }) => {
        const checkRunId = idFor(key.checkName);
        return checkRunId === undefined ? undefined : { checkRunId, stepProgress: [] };
      }),
    };
  }

  /**
   * Create the acted-on repository's own `ci` check runs as the per-repository dispatch path
   * does; returns the ids the global run must not touch.
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
      routingKey: ROUTING_KEY,
      runId: 'run-per-repo',
    });
    expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    const workflowCheckRunId = (await mockChecksCreate.mock.results[0].value).data.id;
    const jobCheckRunId = (await mockChecksCreate.mock.results[1].value).data.id;
    mockChecksCreate.mockClear();
    return { workflowCheckRunId, jobCheckRunId };
  }

  it('names a global workflow check run after the repository that defines it', async () => {
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

    await reporter.setPendingAwait({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: [JOB],
      installationId: 42,
      routingKey: ROUTING_KEY,
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
    // A global workflow firing on its own repository's event is not cross-repository:
    // nothing can collide, so the customer-visible name must not move.
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });

    await reporter.setPendingAwait({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: [JOB],
      installationId: 42,
      routingKey: ROUTING_KEY,
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
    const reporter = new CheckRunReporter({
      providerRegistry: githubRegistry(),
      trackingStore: trackingStore as never,
    });
    const { workflowCheckRunId } = await seedPerRepositoryChecks(reporter);

    reporter.updateWorkflowStatus({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      overallStatus: ExecutionJobStatus.enum.failed,
      installationId: 42,
      routingKey: ROUTING_KEY,
      workflowRepoIdentifier: WORKFLOW_REPO,
      runId: 'run-global',
    });

    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    // The FIRST PATCH, so a wrong target fails on the id it names, not on a timeout.
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
    const reporter = new CheckRunReporter({
      providerRegistry: githubRegistry(),
      trackingStore: trackingStore as never,
    });
    const { jobCheckRunId } = await seedPerRepositoryChecks(reporter);

    reporter.updateJobStatus(
      jobUpdate({
        owner: OWNER,
        repo: REPO,
        sha: SHA,
        workflowName: WORKFLOW,
        jobName: JOB,
        workflowRepoIdentifier: WORKFLOW_REPO,
        runId: 'run-global',
      }),
    );

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
    const reporter = new CheckRunReporter({
      providerRegistry: githubRegistry(),
      trackingStore: trackingStore as never,
    });
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
      routingKey: ROUTING_KEY,
      workflowRepoIdentifier: WORKFLOW_REPO,
      runId: 'run-global',
    });

    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    // The harm: `in_progress` on the acted-on check would push a resolved check back open.
    expect(mockChecksUpdate.mock.calls[0][0]).toMatchObject({
      check_run_id: GLOBAL_JOB_CHECK_ID,
      status: 'in_progress',
    });
    expect(mockChecksUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ check_run_id: jobCheckRunId }),
    );
  });

  it('leaves the acted-on repository check run resolvable after the global run is pruned', async () => {
    // `cleanupRun` evicts every key the run touched, so a global run that resolved the
    // acted-on key would evict that run's check-run id and terminal latch on prune.
    const trackingStore = createGlobalOnlyTrackingStore();
    const reporter = new CheckRunReporter({
      providerRegistry: githubRegistry(),
      trackingStore: trackingStore as never,
    });
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
      routingKey: ROUTING_KEY,
      workflowRepoIdentifier: WORKFLOW_REPO,
      runId: 'run-global',
    });
    // A PATCH lands on either check run, so this wait closes the key-registration race
    // without assuming which behaviour is under test.
    await vi.waitFor(() => expect(mockChecksUpdate).toHaveBeenCalled());
    mockChecksUpdate.mockClear();

    reporter.cleanupRun('run-global');

    reporter.updateJobStatus(
      jobUpdate({
        owner: OWNER,
        repo: REPO,
        sha: SHA,
        workflowName: WORKFLOW,
        jobName: JOB,
        state: ExecutionJobStatus.enum.success,
        runId: 'run-per-repo',
      }),
    );

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
  // Both repositories legally define `ci`; cleanup lists the acted-on commit, so both
  // repositories' checks appear in one response.
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
   * In-progress checks, in order. Callers list the unqualified check FIRST, so a wrong match
   * fails on the id of the first PATCH rather than on a timeout.
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
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry(ROUTING_KEY) });
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
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry(ROUTING_KEY) });
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
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry(ROUTING_KEY) });
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
    // An older Platform omits the field on EVERY run, ordinary ones included; skipping on
    // absence would trade a rare, bounded wrong red for hung checks on every stale run.
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry(ROUTING_KEY) });
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
    // Not a cross-repository run, so the name never moved and cleanup must reach it; the
    // same case as an absent field, which is why the Platform never sends this value.
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry(ROUTING_KEY) });
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
      routingKey: ROUTING_KEY,
      runId: RUN_ID,
    });
  }

  it('completes the workflow check and every per-job check with the given conclusion', async () => {
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
    await seedQueuedChecks(reporter, ['build', 'test']);
    // Non-vacuity: the seed created three QUEUED checks.
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
      routingKey: ROUTING_KEY,
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
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
    await seedQueuedChecks(reporter, []);
    reporter.setBuildPending({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      installationId: 42,
      routingKey: ROUTING_KEY,
      runId: RUN_ID,
    });
    await vi.waitFor(() => {
      expect(mockChecksCreate).toHaveBeenCalledTimes(2);
    });
    // Control: the build check is resolvable, so its absence below is not a lookup miss.
    expect((mockChecksCreate.mock.calls[1][0] as any).name).toBe(`kici/${WORKFLOW}/setup`);

    await reporter.completeUndispatchedCheckRuns({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: [],
      installationId: 42,
      routingKey: ROUTING_KEY,
      runId: RUN_ID,
      conclusion: CheckRunConclusion.enum.timed_out,
      summary: 'The approval window elapsed.',
    });

    expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    expect((mockChecksUpdate.mock.calls[0][0] as any).check_run_id).toBe(1000);
  });

  it('resolves an L1-cached id without reading its tracking row', async () => {
    // Why `kici/<workflow>/setup` is excluded: the latch is rehydrated from
    // `terminal_sent_at` only in the store read, which an L1 hit skips. A build check
    // `setBuildComplete` just completed (row stamped, in-process set untouched) resolves
    // with no latch, and completing it again would overwrite its real conclusion.
    const trackingStore = createTrackingStoreStub();
    const reporter = new CheckRunReporter({
      providerRegistry: githubRegistry(),
      trackingStore: trackingStore as never,
    });
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
      routingKey: ROUTING_KEY,
      runId: RUN_ID,
      conclusion: CheckRunConclusion.enum.cancelled,
      summary: 'cancelled',
    });

    // It completed the check, so the call was not skipped wholesale.
    expect(mockChecksUpdate).toHaveBeenCalledTimes(1);
    expect(trackingStore.getState).not.toHaveBeenCalled();
  });

  it('skips a check run it cannot resolve an id for', async () => {
    // No seed: nothing was ever created, so nothing is resolvable.
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
    await reporter.completeUndispatchedCheckRuns({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      jobNames: ['build'],
      installationId: 42,
      routingKey: ROUTING_KEY,
      runId: RUN_ID,
      conclusion: CheckRunConclusion.enum.cancelled,
      summary: 'nothing to close',
    });
    expect(mockChecksUpdate).not.toHaveBeenCalled();
  });

  it('does not reopen a check this reporter already reported terminal', async () => {
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
    await seedQueuedChecks(reporter, ['build']);
    reporter.updateJobStatus(
      jobUpdate({
        owner: OWNER,
        repo: REPO,
        sha: SHA,
        workflowName: WORKFLOW,
        jobName: 'build',
        state: ExecutionJobStatus.enum.success,
        runId: RUN_ID,
      }),
    );
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
      routingKey: ROUTING_KEY,
      runId: RUN_ID,
      conclusion: CheckRunConclusion.enum.cancelled,
      summary: 'This run was cancelled before any job started.',
    });

    // Only the workflow check moved; the already-terminal job check did not.
    expect(mockChecksUpdate).toHaveBeenCalledTimes(2);
    expect((mockChecksUpdate.mock.calls[1][0] as any).check_run_id).toBe(1000);
  });

  it('qualifies the names for a cross-repository global run', async () => {
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
    await reporter.setPendingAwait({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      sha: SHA,
      workflowName: WORKFLOW,
      workflowRepoIdentifier: 'acme/ci-defs',
      jobNames: ['build'],
      installationId: 42,
      routingKey: ROUTING_KEY,
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
      routingKey: ROUTING_KEY,
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

describe('a re-run on the same commit', () => {
  const OWNER = 'acme';
  const REPO = 'app';
  const SHA = 'cafebabe';
  const WORKFLOW = 'CI';

  beforeEach(() => {
    vi.clearAllMocks();
    checkRunIdCounter = 3000;
  });

  const base = {
    provider: 'github',
    owner: OWNER,
    repo: REPO,
    sha: SHA,
    workflowName: WORKFLOW,
    installationId: 42,
    routingKey: ROUTING_KEY,
  };

  async function seed(reporter: CheckRunReporter, runId: string): Promise<void> {
    await reporter.setPendingAwait({ ...base, jobNames: ['build'], runId });
  }

  async function completeUndispatched(reporter: CheckRunReporter, runId: string): Promise<void> {
    await reporter.completeUndispatchedCheckRuns({
      ...base,
      jobNames: ['build'],
      runId,
      conclusion: CheckRunConclusion.enum.failure,
      summary: 'The workflow build did not complete, so no job started.',
    });
  }

  // fails-when: the original run's terminal latch survives the re-run's new check runs, so
  // the re-run's checks are skipped and stay `queued` forever
  it("completes the re-run's own checks after the original completed", async () => {
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
    await seed(reporter, 'run-a');
    await completeUndispatched(reporter, 'run-a');
    expect(mockChecksUpdate).toHaveBeenCalledTimes(2);

    await seed(reporter, 'run-b');
    const rerunIds = [3002, 3003];
    expect(mockChecksCreate.mock.results.slice(2).length).toBe(2);
    await completeUndispatched(reporter, 'run-b');

    const completedIds = mockChecksUpdate.mock.calls
      .map((c) => c[0] as { check_run_id: number; status: string })
      .filter((u) => u.status === 'completed')
      .map((u) => u.check_run_id);
    expect(completedIds).toEqual(expect.arrayContaining(rerunIds));
  });

  it("a late prune of the original leaves the re-run's state", async () => {
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
    await seed(reporter, 'run-a');
    await completeUndispatched(reporter, 'run-a');
    await seed(reporter, 'run-b');

    reporter.cleanupRun('run-a');
    await completeUndispatched(reporter, 'run-b');

    // Without a tracking store the ids live only in L1: a prune of run-a that evicted the
    // shared keys would leave run-b's checks unresolvable, and nothing would complete.
    const completed = mockChecksUpdate.mock.calls
      .map((c) => c[0] as { check_run_id: number })
      .filter((u) => u.check_run_id >= 3002);
    expect(completed.map((u) => u.check_run_id).sort()).toEqual([3002, 3003]);
  });

  // breaks-if-wrong: a second terminal for the SAME check run is still suppressed
  it('still sends one terminal per check run', async () => {
    const reporter = new CheckRunReporter({ providerRegistry: githubRegistry() });
    await seed(reporter, 'run-b');
    await completeUndispatched(reporter, 'run-b');
    await completeUndispatched(reporter, 'run-b');
    expect(mockChecksUpdate).toHaveBeenCalledTimes(2);
  });
});
