import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  ExecutionStepStatus,
  JobKind,
} from '@kici-dev/engine';
import { runsLogsCommand } from './logs.js';
import * as clientMod from '../../remote/dashboard-client.js';

afterEach(() => vi.restoreAllMocks());

describe('runsLogsCommand', () => {
  it('prints step logs in order with headers', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: ExecutionRunStatus.enum.success }),
      getRunDetail: async () => ({
        jobs: [
          {
            jobId: 'j1',
            jobName: 'build',
            status: ExecutionJobStatus.enum.success,
            steps: [
              { stepIndex: 0, stepName: 'checkout', status: ExecutionStepStatus.enum.success },
            ],
          },
        ],
      }),
      getStepLogs: async () => ({ lines: ['hello', 'world'], totalLines: 2 }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsLogsCommand('r1', {});
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('build');
    expect(printed).toContain('checkout');
    expect(printed).toContain('hello');
  });

  it('filters to a single job with --job', async () => {
    const getStepLogs = vi.fn(async () => ({ lines: ['x'], totalLines: 1 }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: ExecutionRunStatus.enum.success }),
      getRunDetail: async () => ({
        jobs: [
          {
            jobId: 'j1',
            jobName: 'build',
            status: ExecutionJobStatus.enum.success,
            steps: [{ stepIndex: 0, stepName: 's', status: ExecutionStepStatus.enum.success }],
          },
          {
            jobId: 'j2',
            jobName: 'test',
            status: ExecutionJobStatus.enum.success,
            steps: [{ stepIndex: 0, stepName: 's', status: ExecutionStepStatus.enum.success }],
          },
        ],
      }),
      getStepLogs,
    } as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsLogsCommand('r1', { job: 'test' });
    // The job's setup log (step -1), then its one step; nothing from 'build'.
    expect(getStepLogs.mock.calls).toEqual([
      ['r1', 'j2', -1],
      ['r1', 'j2', 0],
    ]);
  });

  const SETUP_DETAIL = {
    jobs: [
      {
        jobId: 'j1',
        jobName: 'build',
        status: ExecutionJobStatus.enum.success,
        startedAt: 1_700_000_000_000,
        steps: [{ stepIndex: 0, stepName: 'compile', status: ExecutionStepStatus.enum.success }],
      },
    ],
  };

  it("prints a job's setup log under a setup heading, ahead of its steps", async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: ExecutionRunStatus.enum.success }),
      getRunDetail: async () => SETUP_DETAIL,
      getStepLogs: async (_r: string, _j: string, stepIndex: number) =>
        stepIndex === -1
          ? { lines: ['[host-install] Dependencies installed'], totalLines: 1 }
          : { lines: ['compiled'], totalLines: 1 },
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand('r1', {});

    const printed = log.mock.calls.map((c) => String(c[0]));
    const setupHeading = printed.findIndex((l) => l.includes('build › (setup)'));
    // fails-when: the command lists only the step rows, so the setup lines a
    // container job's host checkout and install wrote are never printed.
    expect(setupHeading).toBeGreaterThanOrEqual(0);
    expect(printed[setupHeading + 1]).toBe('[host-install] Dependencies installed');
    expect(printed.findIndex((l) => l.includes('build › compile'))).toBeGreaterThan(setupHeading);
  });

  it('prints no setup heading when the orchestrator serves no setup log', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: ExecutionRunStatus.enum.success }),
      getRunDetail: async () => SETUP_DETAIL,
      getStepLogs: async (_r: string, _j: string, stepIndex: number) => {
        if (stepIndex === -1) throw new Error('Step not found');
        return { lines: ['compiled'], totalLines: 1 };
      },
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // breaks-if-wrong: an older orchestrator must not fail the command.
    expect(await runsLogsCommand('r1', {})).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('setup');
    expect(printed).toContain('compiled');
  });

  function mockSetupPage(setupPage: Record<string, unknown>): void {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: ExecutionRunStatus.enum.success }),
      getRunDetail: async () => SETUP_DETAIL,
      getStepLogs: async (_r: string, _j: string, stepIndex: number) =>
        stepIndex === -1 ? setupPage : { lines: ['compiled'], totalLines: 1 },
    } as never);
  }

  it('says so under the setup heading when a job recorded no setup log', async () => {
    mockSetupPage({ lines: [], totalLines: 0, recorded: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand('r1', {});

    const printed = log.mock.calls.map((c) => String(c[0]));
    const setupHeading = printed.findIndex((l) => l.includes('build › (setup)'));
    // fails-when: a job that never wrote a setup log prints nothing, exactly like
    // one whose setup log is empty
    expect(setupHeading).toBeGreaterThanOrEqual(0);
    expect(printed[setupHeading + 1]).toContain('(no setup log recorded for this job)');
  });

  it('says the setup log is empty when one is stored with no lines', async () => {
    mockSetupPage({ lines: [], totalLines: 0, recorded: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand('r1', {});

    const printed = log.mock.calls.map((c) => String(c[0]));
    const setupHeading = printed.findIndex((l) => l.includes('build › (setup)'));
    expect(setupHeading).toBeGreaterThanOrEqual(0);
    expect(printed[setupHeading + 1]).toContain('(the setup log for this job is empty)');
  });

  it('prints no note for a job that never ran on an agent', async () => {
    const notStarted = [
      {
        jobId: 'j1',
        jobName: 'skipped',
        status: ExecutionJobStatus.enum.skipped,
        startedAt: null,
        steps: [],
      },
      // An invoke gate runs on no agent, whatever its start time says.
      {
        jobId: 'j2',
        jobName: 'gate',
        status: ExecutionJobStatus.enum.success,
        startedAt: 1,
        jobKind: JobKind.enum.gate,
        steps: [],
      },
    ];
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: ExecutionRunStatus.enum.success }),
      getRunDetail: async () => ({ jobs: notStarted }),
      getStepLogs: async () => ({ lines: [], totalLines: 0, recorded: false }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand('r1', {});

    // fails-when: every queued, skipped or gate job prints "no setup log recorded"
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('(setup)');
  });

  it('prints no setup heading for an empty page the orchestrator does not qualify', async () => {
    mockSetupPage({ lines: [], totalLines: 0 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand('r1', {});

    // breaks-if-wrong: an orchestrator that does not report `recorded` keeps the silent output
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('(setup)');
    expect(printed).toContain('compiled');
  });

  it('leaves --json unchanged when a job recorded no setup log', async () => {
    mockSetupPage({ lines: [], totalLines: 0, recorded: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand('r1', { json: true });

    // breaks-if-wrong: the note is human output only; the JSON keeps the step-only shape
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ 'build/compile': ['compiled'] });
  });

  /** A job whose one step is named `setup`, the name the setup log's own label uses. */
  const STEP_NAMED_SETUP = {
    jobs: [
      {
        jobId: 'j1',
        jobName: 'build',
        status: ExecutionJobStatus.enum.success,
        steps: [{ stepIndex: 0, stepName: 'setup', status: ExecutionStepStatus.enum.success }],
      },
    ],
  };

  function mockSetupAndStep(detail: unknown): void {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: ExecutionRunStatus.enum.success }),
      getRunDetail: async () => detail,
      getStepLogs: async (_r: string, _j: string, stepIndex: number) => ({
        lines: [stepIndex === -1 ? 'setup-line' : 'step-line'],
        totalLines: 1,
      }),
    } as never);
  }

  it('keeps the setup log apart from a step named setup in --json', async () => {
    mockSetupAndStep(STEP_NAMED_SETUP);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand('r1', { json: true });

    // fails-when: the setup lines are keyed `build/setup`, the step's own key, and one of the
    // two overwrites the other
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
      'setup:build': ['setup-line'],
      'build/setup': ['step-line'],
    });
  });

  it('keys setup lines by the job name with / and % encoded, keeping every value a string array', async () => {
    // Job names a step key or another setup key could collide with once decoded.
    mockSetupAndStep({
      jobs: ['deploy/prod', 'deploy%2Fprod', 'setup:build'].map((jobName, i) => ({
        jobId: `j${i}`,
        jobName,
        status: ExecutionJobStatus.enum.success,
        steps: [{ stepIndex: 0, stepName: 'setup', status: ExecutionStepStatus.enum.success }],
      })),
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand('r1', { json: true });

    const out = JSON.parse(String(log.mock.calls[0]![0])) as Record<string, unknown>;
    // fails-when: a job name's `/` or `%` reaches the key unencoded, so
    // `deploy/prod`'s setup key reads as a step key or equals `deploy%2Fprod`'s.
    expect(out).toEqual({
      'setup:deploy%2Fprod': ['setup-line'],
      'deploy/prod/setup': ['step-line'],
      'setup:deploy%252Fprod': ['setup-line'],
      'deploy%2Fprod/setup': ['step-line'],
      'setup:setup:build': ['setup-line'],
      'setup:build/setup': ['step-line'],
    });
    // breaks-if-wrong: the released shape holds, every value an array of lines,
    // so a consumer that iterates the object reads setup keys like step keys.
    for (const value of Object.values(out)) {
      expect(Array.isArray(value) && value.every((l) => typeof l === 'string')).toBe(true);
    }
  });

  it('prints no setup key in --json when no job wrote a setup log', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: ExecutionRunStatus.enum.success }),
      getRunDetail: async () => SETUP_DETAIL,
      getStepLogs: async (_r: string, _j: string, stepIndex: number) => {
        if (stepIndex === -1) throw new Error('Step not found');
        return { lines: ['step-line'], totalLines: 1 };
      },
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand('r1', { json: true });

    // breaks-if-wrong: a run with no setup log keeps the step-only `<job>/<step>` shape
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ 'build/compile': ['step-line'] });
  });

  it('prints the setup log and a step named setup under distinct headings', async () => {
    mockSetupAndStep(STEP_NAMED_SETUP);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand('r1', {});

    const printed = log.mock.calls.map((c) => String(c[0]));
    const setupHeading = printed.findIndex((l) => l.includes('build › (setup)'));
    const stepHeading = printed.findIndex((l) => l.includes('build › setup '));
    // fails-when: both print under `build › setup`, and the reader cannot tell the
    // workflow setup log from the step's output
    expect(setupHeading).toBeGreaterThanOrEqual(0);
    expect(stepHeading).toBeGreaterThan(setupHeading);
    expect(printed[setupHeading + 1]).toBe('setup-line');
    expect(printed[stepHeading + 1]).toBe('step-line');
  });
});

describe('runsLogsCommand unwraps stored log envelopes', () => {
  const ENVELOPE =
    '{"ts":"2026-09-12T09:30:49.325Z","level":"stdout","msg":"smoke test passed","meta":{}}';

  it('prints the text of each envelope, not the envelope', async () => {
    // fails-when: the text mode prints `logs.lines` verbatim — the shape that
    // shipped — so a developer reading `kici runs logs` sees the store's
    // {"ts":…,"level":"stdout","msg":…} for every line the job printed.
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: ExecutionRunStatus.enum.success }),
      getRunDetail: async () => ({
        jobs: [
          {
            jobId: 'j1',
            jobName: 'build',
            status: ExecutionJobStatus.enum.success,
            steps: [{ stepIndex: 0, stepName: 'verify', status: ExecutionStepStatus.enum.success }],
          },
        ],
      }),
      getStepLogs: async () => ({ lines: [ENVELOPE, 'plain line'], totalLines: 2 }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsLogsCommand('r1', {});
    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed).toContain('smoke test passed');
    expect(printed).not.toContain(ENVELOPE);
    // breaks-if-wrong: a line that is not an envelope still reaches the
    // terminal as itself.
    expect(printed).toContain('plain line');
  });

  it('unwraps in --follow mode too', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: 'r1', status: ExecutionRunStatus.enum.success }),
      getRunDetail: async () => ({
        jobs: [
          {
            jobId: 'j1',
            jobName: 'build',
            status: ExecutionJobStatus.enum.success,
            steps: [{ stepIndex: 0, stepName: 'verify', status: ExecutionStepStatus.enum.success }],
          },
        ],
      }),
      getStepLogs: async () => ({ lines: [ENVELOPE], totalLines: 1 }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsLogsCommand('r1', { follow: true });
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed).toContain('smoke test passed');
    expect(printed).not.toContain(ENVELOPE);
  });
});
