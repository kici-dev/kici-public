import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CheckRunReporter, buildJobFailureDescription } from './check-run-reporter.js';
import { ProviderRegistry, type ProviderBundle } from '../provider-registry.js';
import { ExecutionJobStatus, CheckRunConclusion } from '@kici-dev/engine';

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

vi.mock('../providers/github/auth.js', () => ({
  createInstallationOctokit: vi.fn().mockReturnValue({
    checks: {
      create: (...args: unknown[]) => mockChecksCreate(...args),
      update: (...args: unknown[]) => mockChecksUpdate(...args),
    },
  }),
}));

const githubConfig = {
  appId: '12345',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
};

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
