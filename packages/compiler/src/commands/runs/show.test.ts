import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  ExecutionJobStatus,
  ExecutionRunStatus,
  ExecutionStepStatus,
  HeldRunQueueType,
  HeldRunStatus,
  HoldType,
  InitFailureCategory,
  RunDetailSource,
} from '@kici-dev/engine';
import { runsShowCommand } from './show.js';
import * as clientMod from '../../remote/dashboard-client.js';
import * as heldRunMod from '../held-run-client.js';
import { HeldRunRequestError } from '../held-run-client.js';

// `importActual` keeps `HeldRunRequestError` the class the command's `instanceof`
// compares against; a stub class would never match, and the permission-denied
// path would silently test nothing.
vi.mock('../held-run-client.js', async () => {
  const actual =
    await vi.importActual<typeof import('../held-run-client.js')>('../held-run-client.js');
  return {
    ...actual,
    resolveHeldRunContext: vi.fn(async () => ({
      endpoint: 'https://api.example.test',
      token: 't',
      orgId: 'org-1',
    })),
    listHeldRunsForRun: vi.fn(async () => []),
  };
});

const mockedResolve = vi.mocked(heldRunMod.resolveHeldRunContext);
const mockedListHolds = vi.mocked(heldRunMod.listHeldRunsForRun);

beforeEach(() => {
  mockedResolve.mockResolvedValue({
    endpoint: 'https://api.example.test',
    token: 't',
    orgId: 'org-1',
  });
  mockedListHolds.mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

/** A detail read the Platform served from the orchestrator. */
function proxied(detail: unknown) {
  return async () => ({
    detail,
    source: RunDetailSource.enum['orchestrator-proxy'],
    fallbackReason: null,
  });
}

function runSummary(status: string = ExecutionRunStatus.enum.success) {
  return {
    runId: 'r1',
    status,
    workflowName: 'ci',
    ref: 'main',
    repoIdentifier: 'o/r',
    createdAt: '2026-06-12T00:00:00.000Z',
    startedAt: '2026-06-12T00:00:00.000Z',
  };
}

function stubClient(detail: unknown, status: string = ExecutionRunStatus.enum.success): void {
  vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
    getRun: async () => runSummary(status),
    getRunDetailWithSource: proxied(detail),
  } as never);
}

describe('runsShowCommand', () => {
  it('names every workflow of a run spanning several, and each job with its own', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({ ...runSummary(), workflowNames: ['ci', 'repro-461'] }),
      getRunDetailWithSource: proxied({
        jobs: ['ci', 'repro-461'].map((workflowName, i) => ({
          jobId: `j${i}`,
          jobName: 'mise-pinned',
          workflowName,
          status: ExecutionJobStatus.enum.success,
          steps: [],
        })),
      }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsShowCommand('r1', {});
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    // fails-when: the header names only the first workflow
    expect(printed).toContain('workflows=ci,repro-461');
    // fails-when: the two same-named jobs print identically
    expect(printed).toContain('ci / mise-pinned');
    expect(printed).toContain('repro-461 / mise-pinned');
  });

  it('prints the run header and the jobs/steps tree', async () => {
    stubClient({
      jobs: [
        {
          jobId: 'j1',
          jobName: 'build',
          status: ExecutionJobStatus.enum.success,
          durationMs: 5000,
          steps: [
            {
              stepIndex: 0,
              stepName: 'checkout',
              status: ExecutionStepStatus.enum.success,
              durationMs: 1000,
              exitCode: 0,
            },
          ],
        },
      ],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsShowCommand('r1', {});
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('r1');
    expect(printed).toContain('build');
    expect(printed).toContain('checkout');
    // breaks-if-wrong: a run of one workflow keeps its header and bare job names
    expect(printed).toContain('workflow=ci');
    expect(printed).not.toContain(' / build');
    // A run with neither an init failure nor a hold renders neither section.
    expect(printed).not.toContain('Init failure');
    expect(printed).not.toContain('Approval holds');
  });

  it('emits raw JSON with --json', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => ({
        runId: 'r1',
        status: ExecutionRunStatus.enum.success,
        createdAt: '2026-06-12',
      }),
      getRunDetailWithSource: proxied({ jobs: [] }),
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsShowCommand('r1', { json: true });
    expect(log.mock.calls.some((c) => String(c[0]).includes('"run"'))).toBe(true);
  });

  it('falls back to local history on a Platform 404', async () => {
    vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
      getRun: async () => {
        throw new clientMod.DashboardClientError('not_found', 'Not found.', 404);
      },
    } as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // No local entry for this id -> returns false, but must not throw.
    const ok = await runsShowCommand('local-xyz', { json: true });
    expect(typeof ok).toBe('boolean');
    void log;
  });

  it('renders the run-scoped init failure with its category and reason', async () => {
    stubClient(
      {
        jobs: [],
        initFailure: {
          scope: 'run',
          category: InitFailureCategory.enum.lock_resolution,
          message: 'Lock file not found on ref main',
        },
      },
      ExecutionRunStatus.enum.failed,
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsShowCommand('r1', {});
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Init failure');
    expect(printed).toContain(InitFailureCategory.enum.lock_resolution);
    expect(printed).toContain('Lock file not found on ref main');
  });

  it('renders a rejected job with the context rule that rejected it', async () => {
    const reason =
      "multi-context gate: 'production' rejected (branch_restricted: branch 'feature' not allowed)";
    stubClient(
      {
        jobs: [
          {
            jobId: 'rejected-abc',
            jobName: 'deploy',
            status: ExecutionJobStatus.enum.failed,
            durationMs: null,
            errorMessage: reason,
            initFailure: {
              scope: 'job',
              category: InitFailureCategory.enum.context_rules,
              message: reason,
              jobName: 'deploy',
            },
            steps: [],
          },
        ],
      },
      ExecutionRunStatus.enum.failed,
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsShowCommand('r1', {});
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('deploy');
    expect(printed).toContain(InitFailureCategory.enum.context_rules);
    expect(printed).toContain(reason);
    // The reason is printed once, not twice (errorMessage duplicates it).
    expect(printed.split(reason).length - 1).toBe(1);
  });

  it('renders a job error message when the job carries no init failure', async () => {
    stubClient(
      {
        jobs: [
          {
            jobId: 'j1',
            jobName: 'build',
            status: ExecutionJobStatus.enum.failed,
            durationMs: 10,
            errorMessage: 'Step 2 exited with code 1',
            steps: [],
          },
        ],
      },
      ExecutionRunStatus.enum.failed,
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsShowCommand('r1', {});
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Step 2 exited with code 1');
  });

  it('renders each hold with its context, hold type, status and reason', async () => {
    stubClient({ jobs: [] }, ExecutionRunStatus.enum.held);
    mockedListHolds.mockResolvedValue([
      {
        id: 'h1',
        runId: 'r1',
        jobId: 'deploy',
        status: HeldRunStatus.enum.pending,
        holdType: HoldType.enum.reviewer,
        holdScope: 'job',
        contextName: 'production',
        queueType: HeldRunQueueType.enum.context,
        reason: 'Requires approval from @ops',
      },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsShowCommand('r1', {});
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Approval holds');
    expect(printed).toContain('deploy');
    expect(printed).toContain('production');
    expect(printed).toContain(HoldType.enum.reviewer);
    expect(printed).toContain(HeldRunStatus.enum.pending);
    expect(printed).toContain('Requires approval from @ops');
  });

  it('still prints the run when the held-runs lookup fails', async () => {
    stubClient({
      jobs: [
        {
          jobId: 'j1',
          jobName: 'build',
          status: ExecutionJobStatus.enum.success,
          durationMs: 1,
          steps: [],
        },
      ],
    });
    mockedListHolds.mockRejectedValue(new Error('Access denied.'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsShowCommand('r1', {});
    // The run is still shown, and the failure degrades to a note.
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('build');
    expect(printed).toContain('Access denied.');
    expect(printed).not.toContain('Approval holds');
  });

  it('says nothing when the caller may not read held runs', async () => {
    // A caller with `runs:read` but not the held-runs permission never has this
    // data, so the note would print on every invocation, even with nothing held.
    stubClient({
      jobs: [
        {
          jobId: 'j1',
          jobName: 'build',
          status: ExecutionJobStatus.enum.success,
          durationMs: 1,
          steps: [],
        },
      ],
    });
    mockedListHolds.mockRejectedValue(new HeldRunRequestError('Access denied.', 403));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = await runsShowCommand('r1', {});
    expect(ok).toBe(true);
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('build');
    expect(printed).not.toContain('unavailable');
  });

  it('reports an unreadable held-runs surface in --json', async () => {
    // Both a run with no holds and a run whose holds could not be read render
    // `heldRuns: []`, so only this field tells a machine consumer which it got.
    stubClient({ jobs: [] });
    mockedListHolds.mockRejectedValue(new HeldRunRequestError('Access denied.', 403));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsShowCommand('r1', { json: true });
    const parsed = JSON.parse(log.mock.calls.map((c) => String(c[0])).join('\n')) as {
      heldRuns?: unknown[];
      heldRunsUnavailable?: string;
    };
    expect(parsed.heldRuns).toEqual([]);
    expect(parsed.heldRunsUnavailable).toContain('Access denied.');
  });

  it('omits the unavailable field when the holds were read', async () => {
    // Negative control: an always-present field would satisfy the assertion above.
    stubClient({ jobs: [] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsShowCommand('r1', { json: true });
    const parsed = JSON.parse(log.mock.calls.map((c) => String(c[0])).join('\n')) as {
      heldRunsUnavailable?: string;
    };
    expect(parsed.heldRunsUnavailable).toBeUndefined();
  });

  it('includes the holds in --json output', async () => {
    stubClient({ jobs: [] }, ExecutionRunStatus.enum.held);
    mockedListHolds.mockResolvedValue([
      {
        id: 'h1',
        runId: 'r1',
        jobId: 'deploy',
        status: HeldRunStatus.enum.pending,
        holdType: HoldType.enum.reviewer,
      },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runsShowCommand('r1', { json: true });
    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    const parsed = JSON.parse(printed) as { heldRuns?: { id: string }[] };
    expect(parsed.heldRuns?.[0]?.id).toBe('h1');
  });

  it('prints the stored-copy note on stderr and leaves stdout unchanged', async () => {
    const detail = {
      jobs: [
        {
          jobId: 'j1',
          jobName: 'build',
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
    const render = async (source: string, fallbackReason: string | null) => {
      mockedResolve.mockResolvedValue({
        endpoint: 'https://api.example.test',
        token: 't',
        orgId: 'org-1',
      });
      mockedListHolds.mockResolvedValue([]);
      vi.spyOn(clientMod.DashboardClient, 'load').mockResolvedValue({
        getRun: async () => runSummary(ExecutionRunStatus.enum.failed),
        getRunDetailWithSource: async () => ({ detail, source, fallbackReason }),
      } as never);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ok = await runsShowCommand('r1', {});
      const out = {
        ok,
        stdout: log.mock.calls.map((c) => String(c[0])).join('\n'),
        stderr: err.mock.calls.map((c) => String(c[0])).join('\n'),
      };
      vi.restoreAllMocks();
      return out;
    };
    const stored = await render(RunDetailSource.enum['platform-db'], 'orchestrator_unreachable');
    const proxiedRead = await render(RunDetailSource.enum['orchestrator-proxy'], null);
    // fails-when: a stored-copy read prints the empty tree with no explanation
    expect(stored.stderr).toContain(
      'step detail unavailable: the Platform could not read it from the orchestrator that ran this run (no orchestrator that can serve this run is connected)',
    );
    // breaks-if-wrong: stdout and the exit code do not depend on the source
    expect(stored.stdout).toBe(proxiedRead.stdout);
    expect(stored.ok).toBe(true);
    expect(proxiedRead.stderr).not.toContain('step detail unavailable');
  });
});
