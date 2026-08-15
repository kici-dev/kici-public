/**
 * Tests for `kici-admin runs` CLI subcommands.
 *
 * Verifies that the commands:
 *  - Talk to /api/v1/admin/runs via AdminApiClient (NEVER touches the DB)
 *  - Map each --flag to the correct query string parameter
 *  - Render default tables with correct headers
 *  - Emit raw JSON when --json is supplied
 *  - Compose the split run-detail endpoints (runs show → getRun + getRunJobs)
 *  - Expose the new jobs / ephemeral-key / secret-outputs subcommands
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerRunsCommands } from './runs.js';
import type { AdminApiClient } from '../api-client.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const sampleRun = {
  runId: 'run-abc-123',
  workflowName: 'ci',
  status: 'success',
  provider: 'github',
  repoIdentifier: 'owner/repo',
  ref: 'refs/heads/master',
  sha: 'abcdef1234567890',
  startedAt: '2026-04-07T10:00:00.000Z',
  completedAt: '2026-04-07T10:01:30.000Z',
  durationMs: 90000,
  parentRunId: null,
  triggeredBy: null,
  failureReason: null,
  environment: null,
  trustTier: null,
  createdAt: '2026-04-07T10:00:00.000Z',
};

const sampleRunDetail = {
  ...sampleRun,
  deliveryId: 'delivery-1',
  isTestRun: false,
  originalRunId: null,
  cancelledBy: null,
  lockFileSource: null,
  contributorUsername: null,
};

const sampleJob = {
  jobId: 'job-test',
  jobName: 'test',
  status: 'success',
  matrixValues: null,
  agentId: 'agent-1',
  startedAt: '2026-04-07T10:00:05.000Z',
  completedAt: '2026-04-07T10:01:25.000Z',
  durationMs: 80000,
  errorMessage: null,
  runsOnLabels: ['kici:os:linux'],
  createdAt: '2026-04-07T10:00:05.000Z',
  steps: [
    {
      stepIndex: 0,
      stepName: 'checkout',
      status: 'success',
      startedAt: '2026-04-07T10:00:06.000Z',
      completedAt: '2026-04-07T10:00:10.000Z',
      durationMs: 4000,
      exitCode: 0,
      errorMessage: null,
      stepType: 'step',
    },
    {
      stepIndex: 1,
      stepName: 'run tests',
      status: 'success',
      startedAt: '2026-04-07T10:00:10.000Z',
      completedAt: '2026-04-07T10:01:25.000Z',
      durationMs: 75000,
      exitCode: 0,
      errorMessage: null,
      stepType: 'step',
    },
  ],
};

async function runCommand(args: string[], client: Partial<AdminApiClient>): Promise<CommandResult> {
  const program = new Command();
  program.exitOverride();

  const getClient = () => client as AdminApiClient;
  registerRunsCommands(program, getClient);

  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origStderrWrite = process.stderr.write;
  let exitCode: number | null = null;

  console.log = (...a: any[]) => logs.push(a.join(' '));
  console.error = (...a: any[]) => errors.push(a.join(' '));
  process.stderr.write = ((msg: string | Uint8Array) => {
    errors.push(
      typeof msg === 'string' ? msg.replace(/\n$/, '') : Buffer.from(msg).toString('utf8'),
    );
    return true;
  }) as any;

  const origExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as any;

  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err: any) {
    if (!err.message?.startsWith('EXIT:')) {
      console.log = origLog;
      console.error = origError;
      process.stderr.write = origStderrWrite;
      process.exit = origExit;
      if (err.code?.startsWith('commander.'))
        return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode };
      throw err;
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    process.stderr.write = origStderrWrite;
    process.exit = origExit;
  }

  return { stdout: logs.join('\n'), stderr: errors.join('\n'), exitCode };
}

describe('kici-admin runs CLI commands', () => {
  let mockListRuns: ReturnType<typeof vi.fn>;
  let mockCountRuns: ReturnType<typeof vi.fn>;
  let mockGetRun: ReturnType<typeof vi.fn>;
  let mockGetRunJobs: ReturnType<typeof vi.fn>;
  let mockGetRunEphemeralKey: ReturnType<typeof vi.fn>;
  let mockGetRunSecretOutputs: ReturnType<typeof vi.fn>;
  let mockGetRunStructured: ReturnType<typeof vi.fn>;
  let mockGet: ReturnType<typeof vi.fn>;
  let client: Partial<AdminApiClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListRuns = vi.fn().mockResolvedValue({
      runs: [sampleRun],
      total: 1,
      limit: 20,
      offset: 0,
    });
    mockCountRuns = vi.fn().mockResolvedValue({
      total: 7,
      since: '2026-04-18T00:00:00.000Z',
      status: ['success', 'failed'],
      workflowName: null,
      repo: null,
    });
    mockGetRun = vi.fn().mockResolvedValue({ run: sampleRunDetail });
    mockGetRunJobs = vi.fn().mockResolvedValue({ jobs: [sampleJob] });
    mockGetRunEphemeralKey = vi.fn().mockResolvedValue({
      exists: true,
      createdAt: '2026-04-07T10:00:00.000Z',
    });
    mockGetRunSecretOutputs = vi.fn().mockResolvedValue({
      outputs: [
        {
          id: 'out-1',
          jobId: 'job-test',
          outputKey: 'API_KEY',
          createdAt: '2026-04-07T10:00:10.000Z',
          value: null,
          masked: true,
        },
      ],
    });
    mockGetRunStructured = vi.fn().mockResolvedValue({
      runId: 'run-abc-123',
      workflowName: { untrusted: true, value: 'ci' },
      status: 'failed',
      provider: 'github',
      repoIdentifier: { untrusted: true, value: 'owner/repo' },
      ref: { untrusted: true, value: 'refs/heads/main' },
      sha: 'abcdef1234',
      baseSha: null,
      startedAt: null,
      completedAt: null,
      durationMs: 1000,
      trustTier: 'trusted',
      contributorUsername: null,
      failureCategory: 'step_failed',
      failureReason: { untrusted: true, value: 'boom' },
      triggeredBy: null,
      jobs: [
        {
          jobId: 'j1',
          jobName: { untrusted: true, value: 'build' },
          status: 'failed',
          startedAt: null,
          completedAt: null,
          durationMs: null,
          agentId: null,
          errorMessage: null,
          initFailure: null,
          needs: [],
          outputs: null,
          secretOutputKeys: [],
          steps: [
            {
              stepIndex: 0,
              stepName: { untrusted: true, value: 'compile' },
              status: 'failed',
              exitCode: 1,
              durationMs: null,
              startedAt: null,
              completedAt: null,
              errorMessage: null,
              stepType: 'step',
              checkOutcome: null,
              secretsAccessed: [],
            },
          ],
        },
      ],
    });
    mockGet = vi.fn().mockResolvedValue({
      runId: 'run-eval-1',
      jobId: 'job-eval-1',
      stepIndex: 0,
      totalLines: 2,
      nextCursor: null,
      lines: [
        { untrusted: true, value: '[global-filter] KICI_SOURCE_REPO_PATH=/w/source' },
        { untrusted: true, value: '[global-filter] verdict=true' },
      ],
    });
    client = {
      get: mockGet as any,
      listRuns: mockListRuns as any,
      countRuns: mockCountRuns as any,
      getRun: mockGetRun as any,
      getRunJobs: mockGetRunJobs as any,
      getRunEphemeralKey: mockGetRunEphemeralKey as any,
      getRunSecretOutputs: mockGetRunSecretOutputs as any,
      getRunStructured: mockGetRunStructured as any,
    };
  });

  describe('runs list', () => {
    it('R-1: default call with no filters', async () => {
      const { stdout } = await runCommand(['runs', 'list'], client);

      expect(mockListRuns).toHaveBeenCalledWith({
        status: undefined,
        workflowName: undefined,
        repo: undefined,
        since: undefined,
        limit: 20,
        offset: 0,
      });
      expect(stdout).toContain('run_id');
      expect(stdout).toContain('workflow');
      expect(stdout).toContain('status');
      expect(stdout).toContain('run-abc-123');
    });

    it('R-2: --status and --workflow-name are passed to listRuns', async () => {
      await runCommand(['runs', 'list', '--status', 'failed', '--workflow-name', 'deploy'], client);

      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          workflowName: 'deploy',
        }),
      );
    });

    it('R-2b: csv --status is passed through unchanged (server parses)', async () => {
      await runCommand(['runs', 'list', '--status', 'success,failed'], client);

      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success,failed' }),
      );
    });

    it('R-2c: --since is passed through to listRuns', async () => {
      await runCommand(['runs', 'list', '--since', '2026-04-18T00:00:00Z'], client);

      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({ since: '2026-04-18T00:00:00Z' }),
      );
    });

    it('R-2d: --count skips listRuns and calls countRuns', async () => {
      const { stdout } = await runCommand(
        [
          'runs',
          'list',
          '--count',
          '--since',
          '2026-04-18T00:00:00Z',
          '--status',
          'success,failed',
        ],
        client,
      );
      expect(mockListRuns).not.toHaveBeenCalled();
      expect(mockCountRuns).toHaveBeenCalledWith({
        status: 'success,failed',
        workflowName: undefined,
        repo: undefined,
        since: '2026-04-18T00:00:00Z',
      });
      expect(stdout.trim()).toBe('7');
    });

    it('R-2e: --count --json returns structured count response', async () => {
      const { stdout } = await runCommand(['runs', 'list', '--count', '--json'], client);
      const parsed = JSON.parse(stdout);
      expect(parsed.total).toBe(7);
      expect(parsed.status).toEqual(['success', 'failed']);
    });

    it('R-3: --repo filter is passed to listRuns', async () => {
      await runCommand(['runs', 'list', '--repo', 'owner/repo'], client);

      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: 'owner/repo',
        }),
      );
    });

    it('R-4: --json prints raw JSON and skips the table', async () => {
      const { stdout } = await runCommand(['runs', 'list', '--json'], client);

      expect(stdout).toContain('"runs"');
      expect(stdout).toContain('"run-abc-123"');
      // Must NOT include the table header
      expect(stdout).not.toMatch(/^run_id\s+workflow/m);
    });

    it('R-5: empty results show message', async () => {
      mockListRuns.mockResolvedValue({ runs: [], total: 0, limit: 20, offset: 0 });
      const { stdout } = await runCommand(['runs', 'list'], client);

      expect(stdout).toContain('No execution runs found.');
    });

    it('R-6: sha is truncated to 7 chars in table', async () => {
      const { stdout } = await runCommand(['runs', 'list'], client);

      expect(stdout).toContain('abcdef1');
      expect(stdout).not.toContain('abcdef1234567890');
    });

    it('R-7: duration is formatted as human-readable', async () => {
      const { stdout } = await runCommand(['runs', 'list'], client);

      // 90000ms = 1m30s
      expect(stdout).toContain('1m30s');
    });

    it('R-8: --limit and --offset are passed through', async () => {
      await runCommand(['runs', 'list', '--limit', '50', '--offset', '10'], client);

      expect(mockListRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 50,
          offset: 10,
        }),
      );
    });
  });

  describe('runs show', () => {
    it('R-10: displays run header with metadata', async () => {
      const { stdout } = await runCommand(['runs', 'show', 'run-abc-123'], client);

      expect(mockGetRun).toHaveBeenCalledWith('run-abc-123');
      expect(mockGetRunJobs).toHaveBeenCalledWith('run-abc-123', { includeSteps: true });
      expect(stdout).toContain('Run: run-abc-123');
      expect(stdout).toContain('Workflow:    ci');
      expect(stdout).toContain('Status:      success');
      expect(stdout).toContain('Repo:        owner/repo');
    });

    it('R-11: displays jobs table', async () => {
      const { stdout } = await runCommand(['runs', 'show', 'run-abc-123'], client);

      expect(stdout).toContain('job_id');
      expect(stdout).toContain('job-test');
      expect(stdout).toContain('agent-1');
    });

    it('R-12: displays steps per job', async () => {
      const { stdout } = await runCommand(['runs', 'show', 'run-abc-123'], client);

      expect(stdout).toContain('Steps for test (job-test)');
      expect(stdout).toContain('checkout');
      expect(stdout).toContain('run tests');
    });

    it('R-13: --json prints raw JSON composed from both endpoints', async () => {
      const { stdout } = await runCommand(['runs', 'show', 'run-abc-123', '--json'], client);

      expect(stdout).toContain('"run"');
      expect(stdout).toContain('"jobs"');
      expect(stdout).toContain('"steps"');
      // Must NOT include the formatted header
      expect(stdout).not.toContain('Run: run-abc-123');
    });

    it('R-14: no jobs shows appropriate message', async () => {
      mockGetRunJobs.mockResolvedValue({ jobs: [] });
      const { stdout } = await runCommand(['runs', 'show', 'run-abc-123'], client);

      expect(stdout).toContain('No jobs.');
    });
  });

  describe('runs jobs', () => {
    it('R-20: default call excludes steps', async () => {
      const { stdout } = await runCommand(['runs', 'jobs', 'run-abc-123'], client);

      expect(mockGetRunJobs).toHaveBeenCalledWith('run-abc-123', { includeSteps: false });
      expect(stdout).toContain('job_id');
      expect(stdout).toContain('job-test');
    });

    it('R-21: --include-steps passes true to client', async () => {
      await runCommand(['runs', 'jobs', 'run-abc-123', '--include-steps'], client);

      expect(mockGetRunJobs).toHaveBeenCalledWith('run-abc-123', { includeSteps: true });
    });

    it('R-22: --json emits the raw response', async () => {
      const { stdout } = await runCommand(['runs', 'jobs', 'run-abc-123', '--json'], client);
      expect(stdout).toContain('"jobs"');
      expect(stdout).toContain('"job-test"');
    });

    it('R-23: empty jobs list prints message', async () => {
      mockGetRunJobs.mockResolvedValue({ jobs: [] });
      const { stdout } = await runCommand(['runs', 'jobs', 'run-abc-123'], client);
      expect(stdout).toContain('No jobs for this run.');
    });
  });

  describe('runs ephemeral-key', () => {
    it('R-30: prints exists + created_at when the row is present', async () => {
      const { stdout } = await runCommand(['runs', 'ephemeral-key', 'run-abc-123'], client);

      expect(mockGetRunEphemeralKey).toHaveBeenCalledWith('run-abc-123');
      expect(stdout).toContain('exists: true');
      expect(stdout).toContain('created_at: 2026-04-07T10:00:00.000Z');
    });

    it('R-31: prints exists: false when scrubbed', async () => {
      mockGetRunEphemeralKey.mockResolvedValue({ exists: false, createdAt: null });
      const { stdout } = await runCommand(['runs', 'ephemeral-key', 'run-abc-123'], client);
      expect(stdout).toContain('exists: false');
    });

    it('R-32: --json emits the raw response', async () => {
      const { stdout } = await runCommand(
        ['runs', 'ephemeral-key', 'run-abc-123', '--json'],
        client,
      );
      const parsed = JSON.parse(stdout);
      expect(parsed.exists).toBe(true);
    });
  });

  describe('runs secret-outputs', () => {
    it('R-40: default call renders masked rows (no plaintext)', async () => {
      const { stdout } = await runCommand(['runs', 'secret-outputs', 'run-abc-123'], client);

      expect(mockGetRunSecretOutputs).toHaveBeenCalledWith('run-abc-123', {
        outputKey: undefined,
        reveal: false,
      });
      expect(stdout).toContain('API_KEY');
      expect(stdout).toContain('masked');
      expect(stdout).not.toContain('value');
    });

    it('R-41: --output-key filter is passed through', async () => {
      await runCommand(
        ['runs', 'secret-outputs', 'run-abc-123', '--output-key', 'API_KEY'],
        client,
      );
      expect(mockGetRunSecretOutputs).toHaveBeenCalledWith('run-abc-123', {
        outputKey: 'API_KEY',
        reveal: false,
      });
    });

    it('R-42: --reveal sets reveal=true and warns on stderr', async () => {
      mockGetRunSecretOutputs.mockResolvedValue({
        outputs: [
          {
            id: 'out-1',
            jobId: 'job-test',
            outputKey: 'API_KEY',
            createdAt: '2026-04-07T10:00:10.000Z',
            value: 'plaintext-here',
            masked: false,
          },
        ],
      });
      const { stdout, stderr } = await runCommand(
        ['runs', 'secret-outputs', 'run-abc-123', '--reveal'],
        client,
      );
      expect(mockGetRunSecretOutputs).toHaveBeenCalledWith('run-abc-123', {
        outputKey: undefined,
        reveal: true,
      });
      expect(stderr).toContain('audit');
      expect(stdout).toContain('plaintext-here');
    });

    it('R-43: empty list prints message', async () => {
      mockGetRunSecretOutputs.mockResolvedValue({ outputs: [] });
      const { stdout } = await runCommand(['runs', 'secret-outputs', 'run-abc-123'], client);
      expect(stdout).toContain('No secret outputs for this run.');
    });

    it('R-44: --json emits raw response', async () => {
      const { stdout } = await runCommand(
        ['runs', 'secret-outputs', 'run-abc-123', '--json'],
        client,
      );
      expect(stdout).toContain('"outputs"');
      expect(stdout).toContain('"API_KEY"');
    });
  });

  describe('runs structured', () => {
    it('R-45: --json prints the raw AgentRunResult (untrusted envelopes preserved)', async () => {
      const { stdout } = await runCommand(['runs', 'structured', 'run-abc-123', '--json'], client);
      expect(mockGetRunStructured).toHaveBeenCalledWith('run-abc-123');
      const parsed = JSON.parse(stdout);
      expect(parsed.runId).toBe('run-abc-123');
      expect(parsed.workflowName).toEqual({ untrusted: true, value: 'ci' });
      expect(parsed.failureCategory).toBe('step_failed');
    });

    it('R-46: human view unwraps untrusted values and shows failure category', async () => {
      const { stdout } = await runCommand(['runs', 'structured', 'run-abc-123'], client);
      expect(stdout).toContain('Workflow:');
      expect(stdout).toContain('ci');
      expect(stdout).toContain('step_failed');
      expect(stdout).toContain('compile');
      // The unwrapped human view must not leak the envelope wrapper.
      expect(stdout).not.toContain('untrusted');
    });
  });

  describe('runs logs', () => {
    it('R-47: default fetches step 0 with limit=500 and prints only the line values', async () => {
      const { stdout, stderr } = await runCommand(
        ['runs', 'logs', 'run-eval-1', '--job', 'job-eval-1'],
        client,
      );

      expect(mockGet).toHaveBeenCalledWith(
        '/api/v1/admin/runs/run-eval-1/jobs/job-eval-1/steps/0/logs?limit=500',
      );
      expect(stdout).toBe(
        '[global-filter] KICI_SOURCE_REPO_PATH=/w/source\n[global-filter] verdict=true',
      );
      // Plain output must stay pipeable: no envelope wrapper, no hint on stdout.
      expect(stdout).not.toContain('untrusted');
      expect(stderr).toBe('');
    });

    it('R-48: --step, --limit and --cursor all reach the query string', async () => {
      mockGet.mockResolvedValue({
        runId: 'r',
        jobId: 'j',
        stepIndex: 3,
        totalLines: 0,
        nextCursor: null,
        lines: [],
      });

      await runCommand(
        ['runs', 'logs', 'r', '--job', 'j', '--step', '3', '--limit', '10', '--cursor', '40'],
        client,
      );

      expect(mockGet).toHaveBeenCalledWith(
        '/api/v1/admin/runs/r/jobs/j/steps/3/logs?limit=10&cursor=40',
      );
    });

    it('R-49: ids are URL-encoded into the path', async () => {
      await runCommand(['runs', 'logs', 'run/1', '--job', 'job 2', '--step', '1'], client);

      expect(mockGet).toHaveBeenCalledWith(
        '/api/v1/admin/runs/run%2F1/jobs/job%202/steps/1/logs?limit=500',
      );
    });

    it('R-50: the pagination hint goes to stderr so stdout stays pipeable', async () => {
      mockGet.mockResolvedValue({
        runId: 'run-eval-1',
        jobId: 'job-eval-1',
        stepIndex: 0,
        totalLines: 900,
        nextCursor: '500',
        lines: [{ untrusted: true, value: 'first line' }],
      });

      const { stdout, stderr } = await runCommand(
        ['runs', 'logs', 'run-eval-1', '--job', 'job-eval-1'],
        client,
      );

      expect(stdout).toBe('first line');
      expect(stderr).toContain('--cursor 500');
    });

    it('R-51: --json emits the raw response with untrusted envelopes preserved', async () => {
      const { stdout } = await runCommand(
        ['runs', 'logs', 'run-eval-1', '--job', 'job-eval-1', '--json'],
        client,
      );

      const parsed = JSON.parse(stdout);
      expect(parsed.lines[1]).toEqual({
        untrusted: true,
        value: '[global-filter] verdict=true',
      });
      expect(parsed.totalLines).toBe(2);
    });

    it('R-52: --job is required', async () => {
      const { stderr } = await runCommand(['runs', 'logs', 'run-eval-1'], client);

      expect(mockGet).not.toHaveBeenCalled();
      expect(stderr).toContain('--job');
    });

    it('R-53: an API error is reported and exits 1', async () => {
      mockGet.mockRejectedValue(new Error('HTTP 404: Run run-eval-1 not found'));

      const { stderr, exitCode } = await runCommand(
        ['runs', 'logs', 'run-eval-1', '--job', 'job-eval-1'],
        client,
      );

      expect(stderr).toContain('Run run-eval-1 not found');
      expect(exitCode).toBe(1);
    });
  });
});
