/**
 * `kici-admin runs` talks to /api/v1/admin/runs via AdminApiClient (NEVER the
 * DB), maps each --flag to its query parameter, renders tables or raw JSON
 * (--json), composes the split run-detail endpoints (runs show → getRun +
 * getRunJobs), and exposes the jobs / ephemeral-key / secret-outputs
 * subcommands.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { registerRunsCommands } from './runs.js';
import type { AdminApiClient } from '../api-client.js';
import { runCli } from '../../__test-helpers__/cli.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const sampleRun = {
  runId: '0a1b2c3d-0000-4000-8000-000000000123',
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
  context: null,
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
  const getClient = () => client as AdminApiClient;
  return runCli((p) => registerRunsCommands(p, getClient), args, { captureStderrWrite: true });
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
      runId: '0a1b2c3d-0000-4000-8000-000000000123',
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
      runId: '0e7a1000-0000-4000-8000-000000000001',
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
      expect(stdout).toContain('0a1b2c3d-0000-4000-8000-000000000123');
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
      expect(stdout).toContain('"0a1b2c3d-0000-4000-8000-000000000123"');
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
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );

      expect(mockGetRun).toHaveBeenCalledWith('0a1b2c3d-0000-4000-8000-000000000123');
      expect(mockGetRunJobs).toHaveBeenCalledWith('0a1b2c3d-0000-4000-8000-000000000123', {
        includeSteps: true,
      });
      expect(stdout).toContain('Run: 0a1b2c3d-0000-4000-8000-000000000123');
      expect(stdout).toContain('Workflow:    ci');
      expect(stdout).toContain('Status:      success');
      expect(stdout).toContain('Repo:        owner/repo');
    });

    it('R-11: displays jobs table', async () => {
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );

      expect(stdout).toContain('job_id');
      expect(stdout).toContain('job-test');
      expect(stdout).toContain('agent-1');
    });

    it('R-12: displays steps per job', async () => {
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );

      expect(stdout).toContain('Steps for test (job-test)');
      expect(stdout).toContain('checkout');
      expect(stdout).toContain('run tests');
    });

    it('R-13: --json prints raw JSON composed from both endpoints', async () => {
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123', '--json'],
        client,
      );

      expect(stdout).toContain('"run"');
      expect(stdout).toContain('"jobs"');
      expect(stdout).toContain('"steps"');
      // Must NOT include the formatted header
      expect(stdout).not.toContain('Run: 0a1b2c3d-0000-4000-8000-000000000123');
    });

    it('R-14: no jobs shows appropriate message', async () => {
      mockGetRunJobs.mockResolvedValue({ jobs: [] });
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );

      expect(stdout).toContain('No jobs.');
    });

    it('names the run org and prints each job env warning', async () => {
      // fails-when: the header or the warnings ignore the new fields
      mockGetRun.mockResolvedValue({ run: { ...sampleRunDetail, orgId: 'org_A' } });
      mockGetRunJobs.mockResolvedValue({
        jobs: [{ ...sampleJob, envWarning: "Context 'pages' is not configured in org 'org_A'." }],
      });
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );
      const lines = stdout.split('\n');
      expect(lines[lines.findIndex((l) => l.startsWith('  Provider:')) + 1]).toBe(
        '  Org:         org_A',
      );
      expect(stdout).toContain("  ! test: Context 'pages' is not configured in org 'org_A'.");
    });

    it('prints no Org or warning line for an older orchestrator response', async () => {
      // breaks-if-wrong: a response without the fields renders as before
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );
      expect(stdout).not.toContain('Org:');
      expect(stdout).not.toContain('  ! ');
    });

    it('R-15: an organization-wide run shows where its workflow is defined', async () => {
      mockGetRun.mockResolvedValue({
        run: {
          ...sampleRunDetail,
          workflowRepoIdentifier: 'acme/org-workflows',
          workflowSha: 'def5678def5678',
          workflowBranch: 'main',
        },
      });
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );

      // fails-when: the header omits any of the three provenance lines
      expect(stdout).toContain('Defined in:  acme/org-workflows (organization-wide workflow)');
      expect(stdout).toContain('Workflow SHA: def5678def5678');
      expect(stdout).toContain('Workflow branch: main');
    });

    it('R-16: a run of the repository own workflow prints no provenance lines', async () => {
      mockGetRun.mockResolvedValue({
        run: {
          ...sampleRunDetail,
          workflowRepoIdentifier: null,
          workflowSha: null,
          workflowBranch: null,
        },
      });
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );

      // fails-when: a null provenance still prints a "Defined in:" line
      // breaks-if-wrong: the ordinary header lines must still print
      expect(stdout).not.toContain('Defined in:');
      expect(stdout).not.toContain('Workflow SHA:');
      expect(stdout).not.toContain('Workflow branch:');
      expect(stdout).toContain('Repo:        owner/repo');
    });

    it('R-17: a provenance naming the run own repo prints no "Defined in" line', async () => {
      mockGetRun.mockResolvedValue({
        run: { ...sampleRunDetail, workflowRepoIdentifier: 'owner/repo' },
      });
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );

      // fails-when: the line is gated on "set" alone, unlike the dashboard,
      // which shows "Defined in" only when the two repositories differ
      expect(stdout).not.toContain('Defined in:');
    });

    it('R-18: --json carries the workflow provenance fields', async () => {
      mockGetRun.mockResolvedValue({
        run: {
          ...sampleRunDetail,
          workflowRepoIdentifier: 'acme/org-workflows',
          workflowSha: 'def5678',
          workflowBranch: 'main',
        },
      });
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123', '--json'],
        client,
      );

      // fails-when: the --json path filters the run object down to known keys
      expect(JSON.parse(stdout).run).toMatchObject({
        workflowRepoIdentifier: 'acme/org-workflows',
        workflowSha: 'def5678',
        workflowBranch: 'main',
      });
    });

    it('R-19: the run context prints on its own line', async () => {
      mockGetRun.mockResolvedValue({ run: { ...sampleRunDetail, context: 'production' } });
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );

      // fails-when: the header reads a field the route does not send
      // (`environment`), so the context line never prints
      expect(stdout).toContain('Context:     production');
    });
  });

  describe('runs spanning several workflows', () => {
    const multiJobs = [
      { ...sampleJob, jobId: 'job-a', jobName: 'mise-pinned', workflowName: 'repro-407' },
      { ...sampleJob, jobId: 'job-b', jobName: 'mise-pinned', workflowName: 'repro-461' },
    ];

    it('R-30: runs list counts the workflows beyond the first', async () => {
      mockListRuns.mockResolvedValue({
        runs: [{ ...sampleRun, workflowNames: ['ci', 'repro-407', 'repro-461'] }],
        total: 1,
        limit: 20,
        offset: 0,
      });
      const { stdout } = await runCommand(['runs', 'list'], client);
      // fails-when: the row names only the first workflow
      expect(stdout).toContain('ci +2');
    });

    it('R-31: runs list keeps a lone workflow, and an older orchestrator', async () => {
      // breaks-if-wrong: a run of one workflow, or a response with no workflowNames, prints the name alone
      const { stdout } = await runCommand(['runs', 'list'], client);
      expect(stdout).toContain(' ci ');
      expect(stdout).not.toContain('ci +');
    });

    it('R-32: runs show names every workflow and each job with its own', async () => {
      mockGetRun.mockResolvedValue({
        run: { ...sampleRunDetail, workflowNames: ['ci', 'repro-407', 'repro-461'] },
      });
      mockGetRunJobs.mockResolvedValue({ jobs: multiJobs });
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );
      // fails-when: the header reads as a run of the first workflow alone
      expect(stdout).toContain('Workflows:   ci, repro-407, repro-461');
      expect(stdout).not.toContain('Workflow:    ci');
      // fails-when: the job table has no workflow column, so the two jobs read the same
      expect(stdout).toMatch(/job-a\s+│?\s*mise-pinned\s+│?\s*repro-407/);
      expect(stdout).toMatch(/job-b\s+│?\s*mise-pinned\s+│?\s*repro-461/);
      expect(stdout).toContain('Steps for repro-407 / mise-pinned (job-a)');
    });

    it('R-33: runs jobs shows each job workflow', async () => {
      mockGetRunJobs.mockResolvedValue({ jobs: multiJobs });
      const { stdout } = await runCommand(
        ['runs', 'jobs', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );
      // fails-when: the jobs table has no workflow column
      expect(stdout).toContain('workflow');
      expect(stdout).toContain('repro-461');
    });

    it('R-34: a job with no recorded workflow shows a dash', async () => {
      const { stdout } = await runCommand(
        ['runs', 'jobs', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );
      // breaks-if-wrong: a job from an older orchestrator still renders its row
      expect(stdout).toMatch(/job-test\s+│?\s*test\s+│?\s*-/);
    });
  });

  describe('init steps', () => {
    // An older orchestrator orders steps by index alone, so the init step arrives last.
    const initStep = {
      stepIndex: 1_000_000,
      stepName: 'init:0',
      status: 'success',
      startedAt: '2026-04-07T10:00:05.000Z',
      completedAt: '2026-04-07T10:00:06.000Z',
      durationMs: 1000,
      exitCode: null,
      errorMessage: null,
      stepType: 'init:0',
    };
    const jobWithInit = { ...sampleJob, steps: [...sampleJob.steps, initStep] };
    // An older orchestrator stored the init step untyped ('step'), at its index and under its name.
    const STORED_INIT_TYPES = ['init:0', 'step'];
    const jobWithInitStoredAs = (stepType: string) => ({
      ...sampleJob,
      steps: [...sampleJob.steps, { ...initStep, stepType }],
    });

    /** The step-table rows of the one job, in printed order. */
    function stepRows(stdout: string): string[] {
      const lines = stdout.split('\n');
      const start = lines.findIndex((l) => l.startsWith('Steps for test'));
      return lines.slice(start + 3).filter((l) => l.trim() !== '');
    }

    it.each(STORED_INIT_TYPES)(
      'R-60: runs show labels an init step stored as %s init[n] and lists it first',
      async (stepType) => {
        mockGetRunJobs.mockResolvedValue({ jobs: [jobWithInitStoredAs(stepType)] });
        const { stdout } = await runCommand(
          ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123'],
          client,
        );

        // fails-when: the # column prints the raw stored index (untyped: the row is read as a step)
        expect(stdout).not.toContain('1000000');
        const rows = stepRows(stdout);
        // fails-when: the init step keeps the position its index gives it, after the steps
        expect(rows[0]).toMatch(/^init\[0\]\s+init:0\s+success\s+-\s+1s\s+init$/);
        // breaks-if-wrong: the job's own untyped steps keep their index, order and blank type
        expect(rows[1]).toMatch(/^0\s+checkout\s+success\s+0\s+4s\s*$/);
        expect(rows[2]).toMatch(/^1\s+run tests\b/);
      },
    );

    it('R-61: runs jobs --include-steps labels and orders init steps the same way', async () => {
      mockGetRunJobs.mockResolvedValue({ jobs: [jobWithInit] });
      const { stdout } = await runCommand(
        ['runs', 'jobs', '0a1b2c3d-0000-4000-8000-000000000123', '--include-steps'],
        client,
      );

      // fails-when: the second step table still prints the raw index or the index order
      expect(stdout).not.toContain('1000000');
      const rows = stepRows(stdout);
      expect(rows[0]).toMatch(/^init\[0\]\s+init:0\b/);
      expect(rows[1]).toMatch(/^0\s+checkout\b/);
    });

    it.each(STORED_INIT_TYPES)(
      'R-62: runs structured labels and orders an init step stored as %s the same way',
      async (stepType) => {
        const structured = await (mockGetRunStructured as unknown as () => Promise<any>)();
        const [job] = structured.jobs;
        mockGetRunStructured.mockResolvedValue({
          ...structured,
          jobs: [
            {
              ...job,
              jobName: { untrusted: true, value: 'test' },
              steps: [
                ...job.steps,
                {
                  ...job.steps[0],
                  stepIndex: 1_000_000,
                  stepName: { untrusted: true, value: 'init:0' },
                  stepType,
                  status: 'success',
                  exitCode: null,
                },
              ],
            },
          ],
        });
        const { stdout } = await runCommand(
          ['runs', 'structured', '0a1b2c3d-0000-4000-8000-000000000123'],
          client,
        );

        // fails-when: the structured view prints the raw stored index
        expect(stdout).not.toContain('1000000');
        const rows = stepRows(stdout);
        expect(rows[0]).toMatch(/^init\[0\]\s+init:0\b/);
        // breaks-if-wrong: the step's own index and unwrapped name still print
        expect(rows[1]).toMatch(/^0\s+compile\b/);
      },
    );

    it.each(STORED_INIT_TYPES)(
      'R-64: runs logs --step init[0] reads an init step stored as %s by its stored index',
      async (stepType) => {
        mockGetRunJobs.mockResolvedValue({ jobs: [jobWithInitStoredAs(stepType)] });
        await runCommand(
          [
            'runs',
            'logs',
            '0a1b2c3d-0000-4000-8000-000000000123',
            '--job',
            'job-test',
            '--step',
            'init[0]',
          ],
          client,
        );

        // fails-when: the label is sent as the step index, which the server rejects, or an
        // untyped init step is looked up by its type and reported missing
        expect(mockGet).toHaveBeenCalledWith(
          '/api/v1/admin/runs/0a1b2c3d-0000-4000-8000-000000000123/jobs/job-test/steps/1000000/logs?limit=500',
        );
      },
    );

    it('R-65: runs logs --step init[n] names a missing init step', async () => {
      mockGetRunJobs.mockResolvedValue({ jobs: [jobWithInit] });
      const { stderr, exitCode } = await runCommand(
        [
          'runs',
          'logs',
          '0a1b2c3d-0000-4000-8000-000000000123',
          '--job',
          'job-test',
          '--step',
          'init[3]',
        ],
        client,
      );

      // fails-when: an unknown init label falls through to an opaque server 400
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('has no init[3] step');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('R-67: an empty init log names the step init[n], not its stored index', async () => {
      mockGetRunJobs.mockResolvedValue({ jobs: [jobWithInit] });
      mockGet.mockResolvedValue({
        runId: '0a1b2c3d-0000-4000-8000-000000000123',
        jobId: 'job-test',
        stepIndex: 1_000_000,
        totalLines: 0,
        recorded: false,
        nextCursor: null,
        lines: [],
      });
      const { stderr } = await runCommand(
        [
          'runs',
          'logs',
          '0a1b2c3d-0000-4000-8000-000000000123',
          '--job',
          'job-test',
          '--step',
          'init[0]',
        ],
        client,
      );

      // fails-when: the note prints the stored index the label hides
      expect(stderr).toContain('(no log recorded for step init[0])');
      expect(stderr).not.toContain('1000000');
    });

    it('R-66: runs logs --step with a number does not look up the job', async () => {
      await runCommand(
        [
          'runs',
          'logs',
          '0a1b2c3d-0000-4000-8000-000000000123',
          '--job',
          'job-test',
          '--step',
          '2',
        ],
        client,
      );

      // breaks-if-wrong: a plain index (and an eval round with no run row) needs no lookup
      expect(mockGetRunJobs).not.toHaveBeenCalled();
      expect(mockGet).toHaveBeenCalledWith(
        '/api/v1/admin/runs/0a1b2c3d-0000-4000-8000-000000000123/jobs/job-test/steps/2/logs?limit=500',
      );
    });

    it('R-63: --json keeps the raw stepIndex the server sent', async () => {
      mockGetRunJobs.mockResolvedValue({ jobs: [jobWithInit] });
      const { stdout } = await runCommand(
        ['runs', 'show', '0a1b2c3d-0000-4000-8000-000000000123', '--json'],
        client,
      );

      // fails-when: the JSON view rewrites the stored index it is meant to carry verbatim
      const steps = JSON.parse(stdout).jobs[0].steps;
      expect(steps.map((s: { stepIndex: number }) => s.stepIndex)).toContain(1_000_000);
    });
  });

  describe('short run ids', () => {
    const FULL = '709c899a-b06f-45d0-a3e2-d0a14fa62094';

    it('R-70: runs show resolves a unique prefix to the full run id', async () => {
      mockListRuns.mockResolvedValue({ runs: [{ runId: FULL }], total: 1, limit: 5, offset: 0 });
      await runCommand(['runs', 'show', '709c899a'], client);

      // fails-when: the short id goes to the server as a run id (the issue's opaque HTTP 400)
      expect(mockListRuns).toHaveBeenCalledWith({ runIdPrefix: '709c899a', limit: 5 });
      expect(mockGetRun).toHaveBeenCalledWith(FULL);
      expect(mockGetRunJobs).toHaveBeenCalledWith(FULL, { includeSteps: true });
    });

    it('R-71: runs jobs and runs logs resolve a prefix the same way', async () => {
      mockListRuns.mockResolvedValue({ runs: [{ runId: FULL }], total: 1, limit: 5, offset: 0 });
      await runCommand(['runs', 'jobs', '709c899a'], client);
      expect(mockGetRunJobs).toHaveBeenCalledWith(FULL, { includeSteps: false });
      await runCommand(['runs', 'logs', '709c899a', '--job', 'j'], client);
      expect(mockGet).toHaveBeenCalledWith(
        `/api/v1/admin/runs/${FULL}/jobs/j/steps/0/logs?limit=500`,
      );
    });

    it('R-72: an ambiguous prefix names its matches and fetches nothing', async () => {
      const other = '709c899a-0000-4000-8000-000000000000';
      mockListRuns.mockResolvedValue({
        runs: [{ runId: FULL }, { runId: other }],
        total: 3,
        limit: 5,
        offset: 0,
      });
      const { stderr, exitCode } = await runCommand(['runs', 'show', '709c899a'], client);

      // fails-when: the first match is picked silently
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("Run id prefix '709c899a' is ambiguous");
      expect(stderr).toContain(FULL);
      expect(stderr).toContain(other);
      expect(stderr).toContain('and 1 more');
      expect(mockGetRun).not.toHaveBeenCalled();
    });

    it('R-73: a prefix no run starts with says so', async () => {
      mockListRuns.mockResolvedValue({ runs: [], total: 0, limit: 5, offset: 0 });
      const { stderr, exitCode } = await runCommand(['runs', 'show', 'deadbeef'], client);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("No run id starts with 'deadbeef'");
      expect(stderr).toContain('kici-admin runs list');
    });

    it('R-74: text that cannot be a run id fails before any request', async () => {
      const { stderr, exitCode } = await runCommand(['runs', 'show', 'not-a-run'], client);
      expect(exitCode).not.toBe(0);
      // fails-when: the value reaches the server and returns "malformed value for a typed field"
      expect(stderr).toContain("Invalid run id 'not-a-run'");
      expect(stderr).not.toContain('malformed value');
      expect(mockListRuns).not.toHaveBeenCalled();
      expect(mockGetRun).not.toHaveBeenCalled();
    });

    it.each([
      // fails-when: one match on a page of unrelated runs is picked, though more may exist
      { total: 40, resolves: false },
      // breaks-if-wrong: a small install on an older orchestrator still resolves
      { total: 2, resolves: true },
    ])(
      'R-75: an orchestrator that ignores the prefix filter (total $total)',
      async ({ total, resolves }) => {
        const unrelated = '11111111-0000-4000-8000-000000000000';
        mockListRuns.mockResolvedValue({ runs: [{ runId: unrelated }, { runId: FULL }], total });
        const { stderr } = await runCommand(['runs', 'show', '709c899a'], client);
        if (resolves) expect(mockGetRun).toHaveBeenCalledWith(FULL);
        else expect(stderr).toContain("cannot look up the run id prefix '709c899a'");
      },
    );

    it('R-76: a full run id is used as typed, with no lookup', async () => {
      await runCommand(['runs', 'show', FULL], client);
      // breaks-if-wrong: the common case costs no extra request
      expect(mockListRuns).not.toHaveBeenCalled();
      expect(mockGetRun).toHaveBeenCalledWith(FULL);
    });
  });

  describe('runs jobs', () => {
    it('R-20: default call excludes steps', async () => {
      const { stdout } = await runCommand(
        ['runs', 'jobs', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );

      expect(mockGetRunJobs).toHaveBeenCalledWith('0a1b2c3d-0000-4000-8000-000000000123', {
        includeSteps: false,
      });
      expect(stdout).toContain('job_id');
      expect(stdout).toContain('job-test');
    });

    it('R-21: --include-steps passes true to client', async () => {
      await runCommand(
        ['runs', 'jobs', '0a1b2c3d-0000-4000-8000-000000000123', '--include-steps'],
        client,
      );

      expect(mockGetRunJobs).toHaveBeenCalledWith('0a1b2c3d-0000-4000-8000-000000000123', {
        includeSteps: true,
      });
    });

    it('R-22: --json emits the raw response', async () => {
      const { stdout } = await runCommand(
        ['runs', 'jobs', '0a1b2c3d-0000-4000-8000-000000000123', '--json'],
        client,
      );
      expect(stdout).toContain('"jobs"');
      expect(stdout).toContain('"job-test"');
    });

    it('R-23: empty jobs list prints message', async () => {
      mockGetRunJobs.mockResolvedValue({ jobs: [] });
      const { stdout } = await runCommand(
        ['runs', 'jobs', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );
      expect(stdout).toContain('No jobs for this run.');
    });
  });

  describe('runs ephemeral-key', () => {
    it('R-30: prints exists + created_at when the row is present', async () => {
      const { stdout } = await runCommand(
        ['runs', 'ephemeral-key', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );

      expect(mockGetRunEphemeralKey).toHaveBeenCalledWith('0a1b2c3d-0000-4000-8000-000000000123');
      expect(stdout).toContain('exists: true');
      expect(stdout).toContain('created_at: 2026-04-07T10:00:00.000Z');
    });

    it('R-31: prints exists: false when scrubbed', async () => {
      mockGetRunEphemeralKey.mockResolvedValue({ exists: false, createdAt: null });
      const { stdout } = await runCommand(
        ['runs', 'ephemeral-key', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );
      expect(stdout).toContain('exists: false');
    });

    it('R-32: --json emits the raw response', async () => {
      const { stdout } = await runCommand(
        ['runs', 'ephemeral-key', '0a1b2c3d-0000-4000-8000-000000000123', '--json'],
        client,
      );
      const parsed = JSON.parse(stdout);
      expect(parsed.exists).toBe(true);
    });
  });

  describe('runs secret-outputs', () => {
    it('R-40: default call renders masked rows (no plaintext)', async () => {
      const { stdout } = await runCommand(
        ['runs', 'secret-outputs', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );

      expect(mockGetRunSecretOutputs).toHaveBeenCalledWith('0a1b2c3d-0000-4000-8000-000000000123', {
        outputKey: undefined,
        reveal: false,
      });
      expect(stdout).toContain('API_KEY');
      expect(stdout).toContain('masked');
      expect(stdout).not.toContain('value');
    });

    it('R-41: --output-key filter is passed through', async () => {
      await runCommand(
        [
          'runs',
          'secret-outputs',
          '0a1b2c3d-0000-4000-8000-000000000123',
          '--output-key',
          'API_KEY',
        ],
        client,
      );
      expect(mockGetRunSecretOutputs).toHaveBeenCalledWith('0a1b2c3d-0000-4000-8000-000000000123', {
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
        ['runs', 'secret-outputs', '0a1b2c3d-0000-4000-8000-000000000123', '--reveal'],
        client,
      );
      expect(mockGetRunSecretOutputs).toHaveBeenCalledWith('0a1b2c3d-0000-4000-8000-000000000123', {
        outputKey: undefined,
        reveal: true,
      });
      expect(stderr).toContain('audit');
      expect(stdout).toContain('plaintext-here');
    });

    it('R-43: empty list prints message', async () => {
      mockGetRunSecretOutputs.mockResolvedValue({ outputs: [] });
      const { stdout } = await runCommand(
        ['runs', 'secret-outputs', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );
      expect(stdout).toContain('No secret outputs for this run.');
    });

    it('R-44: --json emits raw response', async () => {
      const { stdout } = await runCommand(
        ['runs', 'secret-outputs', '0a1b2c3d-0000-4000-8000-000000000123', '--json'],
        client,
      );
      expect(stdout).toContain('"outputs"');
      expect(stdout).toContain('"API_KEY"');
    });
  });

  describe('runs structured', () => {
    it('R-45: --json prints the raw AgentRunResult (untrusted envelopes preserved)', async () => {
      const { stdout } = await runCommand(
        ['runs', 'structured', '0a1b2c3d-0000-4000-8000-000000000123', '--json'],
        client,
      );
      expect(mockGetRunStructured).toHaveBeenCalledWith('0a1b2c3d-0000-4000-8000-000000000123');
      const parsed = JSON.parse(stdout);
      expect(parsed.runId).toBe('0a1b2c3d-0000-4000-8000-000000000123');
      expect(parsed.workflowName).toEqual({ untrusted: true, value: 'ci' });
      expect(parsed.failureCategory).toBe('step_failed');
    });

    it('R-46: human view unwraps untrusted values and shows failure category', async () => {
      const { stdout } = await runCommand(
        ['runs', 'structured', '0a1b2c3d-0000-4000-8000-000000000123'],
        client,
      );
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
        ['runs', 'logs', '0e7a1000-0000-4000-8000-000000000001', '--job', 'job-eval-1'],
        client,
      );

      expect(mockGet).toHaveBeenCalledWith(
        '/api/v1/admin/runs/0e7a1000-0000-4000-8000-000000000001/jobs/job-eval-1/steps/0/logs?limit=500',
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
        [
          'runs',
          'logs',
          '0a1b2c3d-0000-4000-8000-0000000000aa',
          '--job',
          'j',
          '--step',
          '3',
          '--limit',
          '10',
          '--cursor',
          '40',
        ],
        client,
      );

      expect(mockGet).toHaveBeenCalledWith(
        '/api/v1/admin/runs/0a1b2c3d-0000-4000-8000-0000000000aa/jobs/j/steps/3/logs?limit=10&cursor=40',
      );
    });

    it('R-49: the job id is URL-encoded into the path', async () => {
      await runCommand(
        ['runs', 'logs', '0a1b2c3d-0000-4000-8000-0000000000aa', '--job', 'job 2', '--step', '1'],
        client,
      );

      expect(mockGet).toHaveBeenCalledWith(
        '/api/v1/admin/runs/0a1b2c3d-0000-4000-8000-0000000000aa/jobs/job%202/steps/1/logs?limit=500',
      );
    });

    it('R-50: the pagination hint goes to stderr so stdout stays pipeable', async () => {
      mockGet.mockResolvedValue({
        runId: '0e7a1000-0000-4000-8000-000000000001',
        jobId: 'job-eval-1',
        stepIndex: 0,
        totalLines: 900,
        nextCursor: '500',
        lines: [{ untrusted: true, value: 'first line' }],
      });

      const { stdout, stderr } = await runCommand(
        ['runs', 'logs', '0e7a1000-0000-4000-8000-000000000001', '--job', 'job-eval-1'],
        client,
      );

      expect(stdout).toBe('first line');
      expect(stderr).toContain('--cursor 500');
    });

    it('R-51: --json emits the raw response with untrusted envelopes preserved', async () => {
      const { stdout } = await runCommand(
        ['runs', 'logs', '0e7a1000-0000-4000-8000-000000000001', '--job', 'job-eval-1', '--json'],
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
      const { stderr } = await runCommand(
        ['runs', 'logs', '0e7a1000-0000-4000-8000-000000000001'],
        client,
      );

      expect(mockGet).not.toHaveBeenCalled();
      expect(stderr).toContain('--job');
    });

    const EMPTY_PAGE = { runId: 'r', jobId: 'j', totalLines: 0, nextCursor: null, lines: [] };

    it('R-54: --step=-1 with no setup log recorded says so on stderr', async () => {
      mockGet.mockResolvedValue({ ...EMPTY_PAGE, stepIndex: -1, recorded: false });

      const { stdout, stderr } = await runCommand(
        ['runs', 'logs', '0a1b2c3d-0000-4000-8000-0000000000aa', '--job', 'j', '--step=-1'],
        client,
      );

      // fails-when: a job that never wrote a setup log prints nothing at all,
      // exactly like one whose setup log is empty
      expect(stdout).toBe('');
      expect(stderr).toBe('(no setup log recorded for this job)');
    });

    it('R-55: --step=-1 with an empty stored setup log says it is empty', async () => {
      mockGet.mockResolvedValue({ ...EMPTY_PAGE, stepIndex: -1, recorded: true });

      const { stdout, stderr } = await runCommand(
        ['runs', 'logs', '0a1b2c3d-0000-4000-8000-0000000000aa', '--job', 'j', '--step=-1'],
        client,
      );

      expect(stdout).toBe('');
      expect(stderr).toBe('(the setup log for this job is empty)');
    });

    it('R-56: a regular step names its index in the empty-log note', async () => {
      mockGet.mockResolvedValue({ ...EMPTY_PAGE, stepIndex: 2, recorded: false });

      const { stderr } = await runCommand(
        ['runs', 'logs', '0a1b2c3d-0000-4000-8000-0000000000aa', '--job', 'j', '--step', '2'],
        client,
      );

      expect(stderr).toBe('(no log recorded for step 2)');
    });

    it('R-57: no note when the orchestrator does not report recorded, or the step has lines', async () => {
      // breaks-if-wrong: an older orchestrator's empty page keeps the silent output
      mockGet.mockResolvedValueOnce({ ...EMPTY_PAGE, stepIndex: -1 });
      const older = await runCommand(
        ['runs', 'logs', '0a1b2c3d-0000-4000-8000-0000000000aa', '--job', 'j', '--step=-1'],
        client,
      );
      expect(older.stderr).toBe('');

      mockGet.mockResolvedValueOnce({
        ...EMPTY_PAGE,
        stepIndex: -1,
        totalLines: 1,
        lines: [{ untrusted: true, value: '[host-checkout] Clone complete' }],
        recorded: true,
      });
      const withLines = await runCommand(
        ['runs', 'logs', '0a1b2c3d-0000-4000-8000-0000000000aa', '--job', 'j', '--step=-1'],
        client,
      );
      expect(withLines.stdout).toBe('[host-checkout] Clone complete');
      expect(withLines.stderr).toBe('');
    });

    it('R-58: --json prints the response and no note', async () => {
      const response = { ...EMPTY_PAGE, stepIndex: -1, recorded: false };
      mockGet.mockResolvedValue(response);

      const { stdout, stderr } = await runCommand(
        [
          'runs',
          'logs',
          '0a1b2c3d-0000-4000-8000-0000000000aa',
          '--job',
          'j',
          '--step=-1',
          '--json',
        ],
        client,
      );

      expect(JSON.parse(stdout)).toEqual(response);
      expect(stderr).toBe('');
    });

    it('R-53: an API error is reported and exits 1', async () => {
      mockGet.mockRejectedValue(
        new Error('HTTP 404: Run 0e7a1000-0000-4000-8000-000000000001 not found'),
      );

      const { stderr, exitCode } = await runCommand(
        ['runs', 'logs', '0e7a1000-0000-4000-8000-000000000001', '--job', 'job-eval-1'],
        client,
      );

      expect(stderr).toContain('Run 0e7a1000-0000-4000-8000-000000000001 not found');
      expect(exitCode).toBe(1);
    });
  });
});
