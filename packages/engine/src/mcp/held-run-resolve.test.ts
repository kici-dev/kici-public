import { describe, it, expect } from 'vitest';
import { resolveHeldRunId, type HeldRunSummary } from './held-run-resolve.js';

const workflowHold: HeldRunSummary = {
  id: 'hold-wf',
  runId: 'run-1',
  jobId: 'deploy',
  holdScope: 'workflow',
  status: 'pending',
};

const jobHold: HeldRunSummary = {
  id: 'hold-job',
  runId: 'run-1',
  jobId: 'deploy',
  holdScope: 'job',
  status: 'pending',
};

const stepHold: HeldRunSummary = {
  id: 'hold-step',
  runId: 'run-1',
  jobId: 'deploy',
  holdScope: 'step',
  stepIndex: 2,
  status: 'pending',
};

describe('resolveHeldRunId', () => {
  it('resolves the sole pending hold when no filter is given', () => {
    const result = resolveHeldRunId([workflowHold], {});
    expect(result).toEqual({ ok: true, heldRunId: 'hold-wf', hold: workflowHold });
  });

  it('ignores non-pending holds when picking the sole pending one', () => {
    const resolved: HeldRunSummary = { ...jobHold, id: 'old', status: 'approved' };
    const result = resolveHeldRunId([resolved, workflowHold], {});
    expect(result).toEqual({ ok: true, heldRunId: 'hold-wf', hold: workflowHold });
  });

  it('errors when multiple pending holds and no filter', () => {
    const result = resolveHeldRunId([workflowHold, { ...jobHold, jobId: 'build' }], {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Multiple pending holds/i);
  });

  it('errors when there are zero pending holds', () => {
    const result = resolveHeldRunId([{ ...workflowHold, status: 'expired' }], {});
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
