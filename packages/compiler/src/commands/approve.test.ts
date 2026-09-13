import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../remote/config.js', () => ({
  loadGlobalConfig: vi.fn(),
}));

const logOutput: string[] = [];
vi.mock('@kici-dev/core', () => ({
  logger: {
    info: vi.fn((msg: string) => logOutput.push(String(msg))),
    error: vi.fn((msg: string) => logOutput.push(String(msg))),
    warn: vi.fn((msg: string) => logOutput.push(String(msg))),
    debug: vi.fn(),
  },
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { loadGlobalConfig } from '../remote/config.js';
import { approveCommand } from './approve.js';
import { rejectCommand } from './reject.js';
import { resolveHeldRunId, type HeldRunSummary } from '@kici-dev/engine';

const mockedLoadConfig = vi.mocked(loadGlobalConfig);

function authedConfig() {
  return {
    pat: 'pat-token',
    platformEndpoint: 'https://api.example.test',
    activeOrgId: 'org-1',
  };
}

const jobHold: HeldRunSummary = {
  id: 'held-job-1',
  runId: 'run-1',
  jobId: 'deploy',
  holdScope: 'job',
  stepIndex: null,
  status: 'pending',
};

const stepHold: HeldRunSummary = {
  id: 'held-step-1',
  runId: 'run-1',
  jobId: 'deploy',
  holdScope: 'step',
  stepIndex: 2,
  status: 'pending',
};

describe('resolveHeldRunId', () => {
  it('picks the sole pending hold when no filters are given', () => {
    const res = resolveHeldRunId([jobHold], {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.heldRunId).toBe('held-job-1');
  });

  it('errors when multiple pending holds exist and no filter disambiguates', () => {
    const res = resolveHeldRunId([jobHold, stepHold], {});
    expect(res.ok).toBe(false);
  });

  it('matches a job hold by --job', () => {
    const res = resolveHeldRunId([jobHold, stepHold], { job: 'deploy' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.heldRunId).toBe('held-job-1');
  });

  it('matches a step hold by --job + --step (step index)', () => {
    const res = resolveHeldRunId([jobHold, stepHold], { job: 'deploy', step: '2' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.heldRunId).toBe('held-step-1');
  });

  it('errors with a clear message when no hold matches', () => {
    const res = resolveHeldRunId([jobHold], { job: 'other' });
    expect(res.ok).toBe(false);
  });
});

describe('approveCommand', () => {
  beforeEach(() => {
    logOutput.length = 0;
    vi.clearAllMocks();
    mockedLoadConfig.mockResolvedValue(authedConfig() as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists held runs then approves the matching held run', async () => {
    const fetchMock = vi
      .fn()
      // 1. GET held-runs?runId=run-1
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ heldRuns: [jobHold] }),
      })
      // 2. POST approve
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await approveCommand('run-1', {});
    expect(ok).toBe(true);

    const listUrl = fetchMock.mock.calls[0][0] as string;
    expect(listUrl).toContain('/api/v1/orgs/org-1/held-runs');
    expect(listUrl).toContain('runId=run-1');

    const approveUrl = fetchMock.mock.calls[1][0] as string;
    expect(approveUrl).toBe(
      'https://api.example.test/api/v1/orgs/org-1/held-runs/held-job-1/approve',
    );
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
  });

  it('fails when no matching hold is found', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ heldRuns: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await approveCommand('run-1', {});
    expect(ok).toBe(false);
    // Only the list call happened, no approve POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('rejectCommand', () => {
  beforeEach(() => {
    logOutput.length = 0;
    vi.clearAllMocks();
    mockedLoadConfig.mockResolvedValue(authedConfig() as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('requires a reason', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ok = await rejectCommand('run-1', {});
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logOutput.join('\n')).toContain('--reason');
  });

  it('lists then rejects with the reason in the body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ heldRuns: [jobHold] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    const ok = await rejectCommand('run-1', { reason: 'not now' });
    expect(ok).toBe(true);
    const rejectCall = fetchMock.mock.calls[1];
    expect(rejectCall[0]).toBe(
      'https://api.example.test/api/v1/orgs/org-1/held-runs/held-job-1/reject',
    );
    expect(JSON.parse((rejectCall[1] as RequestInit).body as string)).toEqual({
      reason: 'not now',
    });
  });
});

/**
 * A job carrying an SDK `requireApproval` AND a security-typed context gate has
 * TWO pending job-scoped holds under one job name — two independent
 * requirements, both of which must be answered. `--job` cannot separate them,
 * so both commands were dead ends for that shape: every error path named a
 * disambiguator the CLI did not register and the candidate list had already
 * collapsed the information for.
 *
 * These drive the real commands end to end, so they cover the option plumbing
 * (`--hold-type` / `--hold` → the resolver filter) and not only the resolver.
 */
describe('approve / reject with two holds on one job', () => {
  const reviewer: HeldRunSummary = { ...jobHold, id: 'held-reviewer', holdType: 'reviewer' };
  const security: HeldRunSummary = { ...jobHold, id: 'held-security', holdType: 'security' };

  beforeEach(() => {
    logOutput.length = 0;
    vi.clearAllMocks();
    mockedLoadConfig.mockResolvedValue(authedConfig() as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** A fetch that answers the list with both holds, then accepts the decision. */
  function twoHoldFetch() {
    return vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ heldRuns: [reviewer, security] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
  }

  it('approves the security hold named by --hold-type', async () => {
    const fetchMock = twoHoldFetch();
    vi.stubGlobal('fetch', fetchMock);

    expect(await approveCommand('run-1', { holdType: 'security' })).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.example.test/api/v1/orgs/org-1/held-runs/held-security/approve',
    );
  });

  it('approves the reviewer hold named by --hold, composed with --job', async () => {
    const fetchMock = twoHoldFetch();
    vi.stubGlobal('fetch', fetchMock);

    expect(await approveCommand('run-1', { hold: 'held-reviewer', job: 'deploy' })).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.example.test/api/v1/orgs/org-1/held-runs/held-reviewer/approve',
    );
  });

  it('rejects the security hold named by --hold-type', async () => {
    const fetchMock = twoHoldFetch();
    vi.stubGlobal('fetch', fetchMock);

    expect(await rejectCommand('run-1', { holdType: 'security', reason: 'no' })).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://api.example.test/api/v1/orgs/org-1/held-runs/held-security/reject',
    );
  });

  it('offers a usable disambiguator when --job alone cannot choose', async () => {
    // The dead end: the old message said "cannot disambiguate" and then pointed
    // at `--job`, the filter that had just failed, above a candidate list that
    // had de-duplicated the two rows into one entry.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ heldRuns: [reviewer, security] }) });
    vi.stubGlobal('fetch', fetchMock);

    expect(await approveCommand('run-1', { job: 'deploy' })).toBe(false);
    // No decision POST — only the list call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const printed = logOutput.join('\n');
    expect(printed).toContain('--hold-type <type>');
    expect(printed).toContain('--hold <id>');
    expect(printed).toContain('deploy (reviewer), deploy (security)');
  });
});
