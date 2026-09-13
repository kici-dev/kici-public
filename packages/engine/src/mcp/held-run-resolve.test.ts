import { describe, it, expect } from 'vitest';
import { resolveHeldRunId, type HeldRunSummary } from './held-run-resolve.js';
import { HeldRunStatus } from '../context/held-run-status.js';

const workflowHold: HeldRunSummary = {
  id: 'hold-wf',
  runId: 'run-1',
  jobId: 'deploy',
  holdScope: 'workflow',
  status: HeldRunStatus.enum.pending,
};

const jobHold: HeldRunSummary = {
  id: 'hold-job',
  runId: 'run-1',
  jobId: 'deploy',
  holdScope: 'job',
  status: HeldRunStatus.enum.pending,
};

const stepHold: HeldRunSummary = {
  id: 'hold-step',
  runId: 'run-1',
  jobId: 'deploy',
  holdScope: 'step',
  stepIndex: 2,
  status: HeldRunStatus.enum.pending,
};

describe('resolveHeldRunId', () => {
  it('resolves the sole pending hold when no filter is given', () => {
    const result = resolveHeldRunId([workflowHold], {});
    expect(result).toEqual({ ok: true, heldRunId: 'hold-wf', hold: workflowHold });
  });

  it('ignores non-pending holds when picking the sole pending one', () => {
    const resolved: HeldRunSummary = { ...jobHold, id: 'old', status: HeldRunStatus.enum.approved };
    const result = resolveHeldRunId([resolved, workflowHold], {});
    expect(result).toEqual({ ok: true, heldRunId: 'hold-wf', hold: workflowHold });
  });

  it('errors when multiple pending holds and no filter', () => {
    const result = resolveHeldRunId([workflowHold, { ...jobHold, jobId: 'build' }], {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Multiple pending holds/i);
  });

  it('errors when there are zero pending holds', () => {
    const result = resolveHeldRunId([{ ...workflowHold, status: HeldRunStatus.enum.expired }], {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No pending approval holds/i);
  });

  it('matches a job/workflow-scoped hold by job name', () => {
    const result = resolveHeldRunId([jobHold, { ...jobHold, id: 'other', jobId: 'build' }], {
      job: 'deploy',
    });
    expect(result).toEqual({ ok: true, heldRunId: 'hold-job', hold: jobHold });
  });

  it('does not match a step-scoped hold with only --job', () => {
    const result = resolveHeldRunId([stepHold], { job: 'deploy' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No pending hold found for job/i);
  });

  it('matches a step-scoped hold by --job + --step', () => {
    const result = resolveHeldRunId([stepHold, jobHold], { job: 'deploy', step: '2' });
    expect(result).toEqual({ ok: true, heldRunId: 'hold-step', hold: stepHold });
  });

  it('requires --job when --step is given', () => {
    const result = resolveHeldRunId([stepHold], { step: '2' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--step requires --job/i);
  });

  it('errors when no step hold matches the given index', () => {
    const result = resolveHeldRunId([stepHold], { job: 'deploy', step: '9' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No pending hold found for step 9/i);
  });

  it('errors when a job filter matches multiple non-step holds', () => {
    const result = resolveHeldRunId([workflowHold, jobHold], { job: 'deploy' });
    expect(result.ok).toBe(false);
    // The message must name a filter that can actually separate them. It used
    // to say "cannot disambiguate" and then offer `--job`, which is the filter
    // that had just failed.
    if (!result.ok) {
      expect(result.error).toContain('--hold-type <type>');
      expect(result.error).toContain('--hold <id>');
    }
  });
});

describe('resolveHeldRunId candidate listing', () => {
  const pendingHolds: HeldRunSummary[] = [
    {
      id: 'h1',
      runId: 'r1',
      jobId: 'deploy',
      holdScope: 'job',
      status: HeldRunStatus.enum.pending,
    },
    {
      id: 'h2',
      runId: 'r1',
      jobId: 'migrate',
      holdScope: 'step',
      stepIndex: 3,
      status: HeldRunStatus.enum.pending,
    },
  ];

  it('names the candidates when no filter disambiguates the run', () => {
    const result = resolveHeldRunId(pendingHolds, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Candidates: deploy, step 3 of migrate.');
  });

  it('names the ids when two candidates would otherwise render identically', () => {
    // The old listing de-duplicated on the rendered description, so two
    // distinct holds collapsed to `Candidates: deploy.` — one entry, naming a
    // filter that had already failed, with no way to pick either one. The ids
    // are what `--hold <id>` takes, so they have to be printed.
    const dupes: HeldRunSummary[] = [
      { ...pendingHolds[0], id: 'h1' },
      { ...pendingHolds[0], id: 'h1b' },
    ];
    const result = resolveHeldRunId(dupes, { job: 'deploy' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Candidates: deploy [h1], deploy [h1b].');
  });

  it('lists the pending holds when the named job matches nothing', () => {
    const result = resolveHeldRunId(pendingHolds, { job: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No pending hold found for job 'nope'.");
      expect(result.error).toContain('Pending holds: deploy, step 3 of migrate.');
    }
  });

  it('prints the literal job id, including a run-wide install sentinel', () => {
    const holds: HeldRunSummary[] = [
      {
        id: 'h3',
        runId: 'r1',
        jobId: '__install__ci',
        holdScope: 'workflow',
        status: HeldRunStatus.enum.pending,
      },
      pendingHolds[0],
    ];
    const result = resolveHeldRunId(holds, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Candidates: __install__ci, deploy.');
  });

  it('names a hold with no job id without printing undefined', () => {
    const holds: HeldRunSummary[] = [
      { id: 'h4', runId: 'r1', holdScope: 'job', status: HeldRunStatus.enum.pending },
      pendingHolds[0],
    ];
    const result = resolveHeldRunId(holds, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Candidates: (unnamed hold), deploy.');
      expect(result.error).not.toContain('undefined');
    }
  });

  it('names a hold with an empty job id rather than listing a blank candidate', () => {
    const holds: HeldRunSummary[] = [
      { id: 'h5', runId: 'r1', jobId: '', holdScope: 'job', status: HeldRunStatus.enum.pending },
      pendingHolds[0],
    ];
    const result = resolveHeldRunId(holds, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Candidates: (unnamed hold), deploy.');
  });

  it('carries the hold type through resolution', () => {
    const hold: HeldRunSummary = { ...jobHold, holdType: 'security' };
    const resolved = resolveHeldRunId([hold], { job: hold.jobId });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.hold.holdType).toBe('security');
  });

  it('leaves the hold type undefined when the orchestrator omitted it', () => {
    const resolved = resolveHeldRunId([jobHold], { job: jobHold.jobId });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.hold.holdType).toBeUndefined();
  });
});

/**
 * One job can carry more than one pending hold. An SDK `requireApproval` paired
 * with a security-typed context gate writes two job-scoped rows under one job
 * name, because two independent requirements gate the job and both have to be
 * answered. `--job` cannot separate those, so `kici approve` / `kici reject`
 * and the MCP `approve_run` / `reject_run` tools were dead ends for that shape:
 * both error paths named a disambiguator that could not disambiguate.
 */
describe('resolveHeldRunId — two holds on one job', () => {
  const reviewer: HeldRunSummary = {
    id: 'hold-reviewer',
    runId: 'r1',
    jobId: 'deploy',
    holdScope: 'job',
    status: HeldRunStatus.enum.pending,
    holdType: 'reviewer',
  };
  const security: HeldRunSummary = { ...reviewer, id: 'hold-security', holdType: 'security' };
  const both = [reviewer, security];

  it('lists both, distinguished by type, when no filter is given', () => {
    const result = resolveHeldRunId(both, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Candidates: deploy (reviewer), deploy (security).');
    }
  });

  it('lists both, distinguished by type, when --job matches them both', () => {
    const result = resolveHeldRunId(both, { job: 'deploy' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Candidates: deploy (reviewer), deploy (security).');
    }
  });

  it('resolves the security hold by type', () => {
    const result = resolveHeldRunId(both, { holdType: 'security' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.heldRunId).toBe('hold-security');
  });

  it('resolves the reviewer hold by type, composed with --job', () => {
    const result = resolveHeldRunId(both, { job: 'deploy', holdType: 'reviewer' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.heldRunId).toBe('hold-reviewer');
  });

  it('normalizes a legacy persisted spelling on both sides', () => {
    // `approval` is what an un-upgraded orchestrator wrote for a reviewer hold,
    // so a caller typing either spelling has to reach the same row.
    const legacy = [{ ...reviewer, holdType: 'approval' }, security];
    expect(resolveHeldRunId(legacy, { holdType: 'reviewer' })).toMatchObject({
      ok: true,
      heldRunId: 'hold-reviewer',
    });
    expect(resolveHeldRunId(both, { holdType: 'approval' })).toMatchObject({
      ok: true,
      heldRunId: 'hold-reviewer',
    });
  });

  it('resolves either hold by its own id, ignoring the other filters', () => {
    expect(resolveHeldRunId(both, { holdId: 'hold-security' })).toMatchObject({
      ok: true,
      heldRunId: 'hold-security',
    });
    // A job filter that would match both does not narrow an id lookup further.
    expect(resolveHeldRunId(both, { holdId: 'hold-reviewer', job: 'deploy' })).toMatchObject({
      ok: true,
      heldRunId: 'hold-reviewer',
    });
  });

  it('reports the pending holds when the id matches none', () => {
    const result = resolveHeldRunId(both, { holdId: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No pending hold found for hold 'nope'.");
      expect(result.error).toContain('Pending holds: deploy (reviewer), deploy (security).');
    }
  });

  it('reports the pending holds when the type matches none', () => {
    const result = resolveHeldRunId(both, { holdType: 'timer' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No pending hold found for hold type 'timer'.");
  });

  it('falls back to ids when the orchestrator sent no hold types at all', () => {
    // An older orchestrator's list response carries no `holdType`, so the
    // description cannot separate the rows and only `--hold <id>` can.
    const untyped: HeldRunSummary[] = [
      { ...reviewer, holdType: undefined },
      { ...security, holdType: undefined },
    ];
    const result = resolveHeldRunId(untyped, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Candidates: deploy [hold-reviewer], deploy [hold-security].');
    }
    expect(resolveHeldRunId(untyped, { holdId: 'hold-security' })).toMatchObject({ ok: true });
  });

  it('narrows a step hold by type as well', () => {
    const stepA: HeldRunSummary = {
      id: 'step-a',
      runId: 'r1',
      jobId: 'migrate',
      holdScope: 'step',
      stepIndex: 2,
      status: HeldRunStatus.enum.pending,
      holdType: 'reviewer',
    };
    const stepB: HeldRunSummary = { ...stepA, id: 'step-b', holdType: 'security' };
    const result = resolveHeldRunId([stepA, stepB], {
      job: 'migrate',
      step: '2',
      holdType: 'security',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.heldRunId).toBe('step-b');
  });
});
