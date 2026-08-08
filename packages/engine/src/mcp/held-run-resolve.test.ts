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
    if (!result.ok) expect(result.error).toMatch(/cannot disambiguate/i);
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

  it('names the candidates when a job filter still matches several holds', () => {
    const dupes: HeldRunSummary[] = [
      { ...pendingHolds[0], id: 'h1' },
      { ...pendingHolds[0], id: 'h1b' },
    ];
    const result = resolveHeldRunId(dupes, { job: 'deploy' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Candidates: deploy.');
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
