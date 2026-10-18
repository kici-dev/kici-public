import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  ExecutionStepStatus,
  JobKind,
  RunDetailSource,
} from '@kici-dev/engine';
import { logger } from '@kici-dev/core';
import { runsLogsCommand } from './logs.js';
import * as clientMod from '../../remote/dashboard-client.js';

/** A run id the commands accept as a full id. */
const RUN = '0f1e2d3c-0000-4000-8000-000000000001';

afterEach(() => vi.restoreAllMocks());

/** A detail read the Platform served from the orchestrator. */
function proxied(detail: unknown) {
  return async () => ({
    detail,
    source: RunDetailSource.enum['orchestrator-proxy'],
    fallbackReason: null,
  });
}

describe('runsLogsCommand', () => {
  it('reads the logs of the run a unique short id names', async () => {
    const full = '709c899a-b06f-45d0-a3e2-d0a14fa62094';
    const getRunDetailWithSource = vi.fn(proxied({ jobs: [] }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      listRuns: async () => ({ runs: [{ runId: full }], hasMore: false }),
      getRunDetailWithSource,
    } as never);
    // fails-when: the short id is sent as a run id
    expect(await runsLogsCommand('709c899a', { json: true })).toBe(true);
    expect(getRunDetailWithSource).toHaveBeenCalledWith(full);
  });

  it('refuses text that cannot be a run id with a clear message', async () => {
    const load = vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({} as never);
    const err = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    expect(await runsLogsCommand('not-a-run', {})).toBe(false);
    expect(String(err.mock.calls[0]?.[0])).toContain("Invalid run id 'not-a-run'");
    expect(load).toHaveBeenCalled();
  });

  it('prints step logs in order with headers', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.success }),
      getRunDetailWithSource: proxied({
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
    const ok = await runsLogsCommand(RUN, {});
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('build');
    expect(printed).toContain('checkout');
    expect(printed).toContain('hello');
  });

  it('filters to a single job with --job', async () => {
    const getStepLogs = vi.fn(async () => ({ lines: ['x'], totalLines: 1 }));
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.success }),
      getRunDetailWithSource: proxied({
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
    await runsLogsCommand(RUN, { job: 'test' });
    // The job's setup log (step -1), then its one step; nothing from 'build'.
    expect(getStepLogs.mock.calls).toEqual([
      [RUN, 'j2', -1],
      [RUN, 'j2', 0],
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
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.success }),
      getRunDetailWithSource: proxied(SETUP_DETAIL),
      getStepLogs: async (_r: string, _j: string, stepIndex: number) =>
        stepIndex === -1
          ? { lines: ['[host-install] Dependencies installed'], totalLines: 1 }
          : { lines: ['compiled'], totalLines: 1 },
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand(RUN, {});

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
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.success }),
      getRunDetailWithSource: proxied(SETUP_DETAIL),
      getStepLogs: async (_r: string, _j: string, stepIndex: number) => {
        if (stepIndex === -1) throw new Error('Step not found');
        return { lines: ['compiled'], totalLines: 1 };
      },
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    // breaks-if-wrong: an older orchestrator must not fail the command.
    expect(await runsLogsCommand(RUN, {})).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('setup');
    expect(printed).toContain('compiled');
    // The older orchestrator's refusal is reported on stderr, not swallowed.
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'setup log unavailable for job build: Step not found',
    );
  });

  it('names on stderr why the setup log could not be read, leaving stdout and the exit code unchanged', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.success }),
      getRunDetailWithSource: proxied(SETUP_DETAIL),
      getStepLogs: async (_r: string, _j: string, stepIndex: number) => {
        if (stepIndex === -1) {
          throw new clientMod.DashboardClientError(
            'orchestrator_offline',
            'Orchestrator timed out — try again shortly.',
            504,
          );
        }
        return { lines: ['compiled'], totalLines: 1 };
      },
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runsLogsCommand(RUN, {})).toBe(true);
    // fails-when: the setup-log error is swallowed into an empty page
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'setup log unavailable for job build: Orchestrator timed out — try again shortly.',
    );
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('compiled');
  });

  it('names the reason on stderr when the recorded cluster is offline and the fallback cannot serve the run', async () => {
    const STARTED_NO_STEPS = {
      jobs: [
        {
          jobId: 'j1',
          jobName: 'initfail',
          status: ExecutionJobStatus.enum.failed,
          matrixValues: null,
          startedAt: 1_700_000_000_000,
          completedAt: 1_700_000_060_000,
          durationMs: 60_000,
          agentId: 'a1',
          errorMessage: null,
          steps: [],
        },
      ],
    };
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.failed }),
      getRunDetailWithSource: async () => ({
        detail: STARTED_NO_STEPS,
        source: 'platform-db',
        fallbackReason: 'orchestrator_error',
      }),
      getStepLogs: async () => {
        throw new clientMod.DashboardClientError('http', 'Run not found', 500);
      },
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    // breaks-if-wrong: the exit code stays true; only stderr explains
    expect(await runsLogsCommand(RUN, {})).toBe(true);
    const stderr = err.mock.calls.map((c) => String(c[0])).join('\n');
    // fails-when: the command exits 0 having printed nothing anywhere
    expect(stderr).toContain(
      'step detail unavailable: the Platform could not read it from the orchestrator that ran this run (the orchestrator returned an error)',
    );
    expect(stderr).toContain('setup log unavailable for job initfail: Run not found');
    // The stored copy has no steps, so stdout carries no step section.
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('initfail ›');
  });

  function mockSetupPage(setupPage: Record<string, unknown>): void {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.success }),
      getRunDetailWithSource: proxied(SETUP_DETAIL),
      getStepLogs: async (_r: string, _j: string, stepIndex: number) =>
        stepIndex === -1 ? setupPage : { lines: ['compiled'], totalLines: 1 },
    } as never);
  }

  it('says so under the setup heading when a job recorded no setup log', async () => {
    mockSetupPage({ lines: [], totalLines: 0, recorded: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand(RUN, {});

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

    await runsLogsCommand(RUN, {});

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
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.success }),
      getRunDetailWithSource: proxied({ jobs: notStarted }),
      getStepLogs: async () => ({ lines: [], totalLines: 0, recorded: false }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand(RUN, {});

    // fails-when: every queued, skipped or gate job prints "no setup log recorded"
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('(setup)');
  });

  it('prints no setup heading for an empty page the orchestrator does not qualify', async () => {
    mockSetupPage({ lines: [], totalLines: 0 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand(RUN, {});

    // breaks-if-wrong: an orchestrator that does not report `recorded` keeps the silent output
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('(setup)');
    expect(printed).toContain('compiled');
  });

  it('leaves --json unchanged when a job recorded no setup log', async () => {
    mockSetupPage({ lines: [], totalLines: 0, recorded: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand(RUN, { json: true });

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
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.success }),
      getRunDetailWithSource: proxied(detail),
      getStepLogs: async (_r: string, _j: string, stepIndex: number) => ({
        lines: [stepIndex === -1 ? 'setup-line' : 'step-line'],
        totalLines: 1,
      }),
    } as never);
  }

  it('keeps the setup log apart from a step named setup in --json', async () => {
    mockSetupAndStep(STEP_NAMED_SETUP);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand(RUN, { json: true });

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

    await runsLogsCommand(RUN, { json: true });

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
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.success }),
      getRunDetailWithSource: proxied(SETUP_DETAIL),
      getStepLogs: async (_r: string, _j: string, stepIndex: number) => {
        if (stepIndex === -1) throw new Error('Step not found');
        return { lines: ['step-line'], totalLines: 1 };
      },
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand(RUN, { json: true });

    // breaks-if-wrong: a run with no setup log keeps the step-only `<job>/<step>` shape
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ 'build/compile': ['step-line'] });
  });

  it('prints the setup log and a step named setup under distinct headings', async () => {
    mockSetupAndStep(STEP_NAMED_SETUP);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runsLogsCommand(RUN, {});

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
    // fails-when: the text mode prints `logs.lines` verbatim, so `kici runs logs`
    // shows the store's {"ts":…,"level":"stdout","msg":…} for every line.
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.success }),
      getRunDetailWithSource: proxied({
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
    await runsLogsCommand(RUN, {});
    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed).toContain('smoke test passed');
    expect(printed).not.toContain(ENVELOPE);
    // breaks-if-wrong: a line that is not an envelope still reaches the
    // terminal as itself.
    expect(printed).toContain('plain line');
  });

  it('unwraps in --follow mode too', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ runId: RUN, status: ExecutionRunStatus.enum.success }),
      getRunDetailWithSource: proxied({
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
    const ok = await runsLogsCommand(RUN, { follow: true });
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed).toContain('smoke test passed');
    expect(printed).not.toContain(ENVELOPE);
  });
});
