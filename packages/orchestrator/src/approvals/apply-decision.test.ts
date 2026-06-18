/**
 * Tests for the shared approve/reject applier. Exercises eligibility gating,
 * multi-clause accumulation, the release+resume path for job scope, the step
 * branch, and rejection.
 */
import { describe, it, expect, vi } from 'vitest';

import { applyDecision, type ApplyDecisionDeps } from './apply-decision.js';
import type { TeamMembershipLookup } from './approval-resolver.js';

const leadsLookup: TeamMembershipLookup = (team) =>
  team === 'leads' ? new Set(['u-alice', 'u-bob']) : new Set();

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    getById: vi.fn(),
    listDecisions: vi.fn().mockResolvedValue([]),
    recordDecision: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    release: vi.fn(),
    ...overrides,
  } as any;
}

function makeDeps(store: any, overrides: Partial<ApplyDecisionDeps> = {}): ApplyDecisionDeps {
  return {
    orgId: 'org-1',
    store,
    teamMembershipLookup: leadsLookup,
    allowSelfApproval: true,
    resolveTriggererSub: vi.fn().mockResolvedValue('u-triggerer'),
    onJobRelease: vi.fn().mockResolvedValue(undefined),
    onStepRelease: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const pendingHold = {
  id: 'hr-1',
  run_id: 'run-1',
  job_id: 'deploy',
  status: 'pending',
  hold_scope: 'job',
  step_index: null,
  approval_requirement: { clauses: [{ team: 'leads' }], expiresAt: 'x', reason: 'r' },
};

describe('applyDecision', () => {
  it('returns not-found for a missing or resolved hold', async () => {
    const store = makeStore({ getById: vi.fn().mockResolvedValue(null) });
    const result = await applyDecision(makeDeps(store), {
      heldRunId: 'hr-x',
      actorSub: 'u-alice',
      decision: 'approve',
    });
    expect(result.status).toBe('not-found');
    expect(result.accepted).toBe(false);
  });

  it('rejects an ineligible approver', async () => {
    const store = makeStore({ getById: vi.fn().mockResolvedValue(pendingHold) });
    const result = await applyDecision(makeDeps(store), {
      heldRunId: 'hr-1',
      actorSub: 'u-outsider',
      decision: 'approve',
    });
    expect(result.status).toBe('ineligible');
    expect(store.recordDecision).not.toHaveBeenCalled();
  });

  it('releases and resumes a job hold once all clauses are satisfied', async () => {
    const store = makeStore({
      getById: vi.fn().mockResolvedValue(pendingHold),
      // After recording, the decision list includes the approve.
      listDecisions: vi
        .fn()
        .mockResolvedValueOnce([]) // pre-record (eligibility check)
        .mockResolvedValueOnce([{ approver_user_id: 'u-alice', decision: 'approve' }]),
      release: vi.fn().mockResolvedValue({
        holdId: 'hr-1',
        runId: 'run-1',
        jobId: 'deploy',
        scope: 'job',
        stepIndex: null,
        triggerSource: 'explicit',
      }),
    });
    const deps = makeDeps(store);
    const result = await applyDecision(deps, {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'approve',
    });

    expect(result.status).toBe('released');
    expect(store.recordDecision).toHaveBeenCalledTimes(1);
    expect(store.release).toHaveBeenCalledWith('org-1', 'hr-1');
    expect(deps.onJobRelease).toHaveBeenCalledTimes(1);
    expect(deps.onStepRelease).not.toHaveBeenCalled();
  });

  it('stays pending when more clauses remain', async () => {
    const twoClauseHold = {
      ...pendingHold,
      approval_requirement: {
        clauses: [{ team: 'leads' }, { user: 'u-cto' }],
        expiresAt: 'x',
        reason: 'r',
      },
    };
    const store = makeStore({
      getById: vi.fn().mockResolvedValue(twoClauseHold),
      listDecisions: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ approver_user_id: 'u-alice', decision: 'approve' }]),
    });
    const result = await applyDecision(makeDeps(store), {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'approve',
    });
    expect(result.status).toBe('pending');
    expect(result.remainingClauses).toBe(1);
    expect(store.release).not.toHaveBeenCalled();
  });

  it('routes a step-scoped release to onStepRelease', async () => {
    const stepHold = { ...pendingHold, hold_scope: 'step', step_index: 2 };
    const store = makeStore({
      getById: vi.fn().mockResolvedValue(stepHold),
      listDecisions: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ approver_user_id: 'u-alice', decision: 'approve' }]),
      release: vi.fn().mockResolvedValue({
        holdId: 'hr-1',
        runId: 'run-1',
        jobId: 'deploy',
        scope: 'step',
        stepIndex: 2,
        triggerSource: 'explicit',
      }),
    });
    const deps = makeDeps(store);
    const result = await applyDecision(deps, {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'approve',
    });
    expect(result.status).toBe('released');
    expect(deps.onStepRelease).toHaveBeenCalledTimes(1);
    expect(deps.onJobRelease).not.toHaveBeenCalled();
  });

  it('routes a workflow-scoped install-gate release to onWorkflowRelease', async () => {
    const workflowHold = { ...pendingHold, hold_scope: 'workflow', job_id: '__install__CI' };
    const store = makeStore({
      getById: vi.fn().mockResolvedValue(workflowHold),
      listDecisions: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ approver_user_id: 'u-alice', decision: 'approve' }]),
      release: vi.fn().mockResolvedValue({
        holdId: 'hr-1',
        runId: 'run-1',
        jobId: '__install__CI',
        scope: 'workflow',
        stepIndex: null,
        // Install-gate holds are environment-triggered.
        triggerSource: 'environment',
      }),
    });
    const onWorkflowRelease = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(store, { onWorkflowRelease });
    const result = await applyDecision(deps, {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'approve',
    });
    expect(result.status).toBe('released');
    expect(onWorkflowRelease).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'workflow', runId: 'run-1' }),
    );
    expect(deps.onJobRelease).not.toHaveBeenCalled();
  });

  it('routes an explicit workflow-scoped release to onJobRelease (re-dispatch the held root job)', async () => {
    // A workflow-level SDK `requireApproval: true` holds a real root job under a
    // workflow-scoped, explicit-triggered hold. Releasing it must re-dispatch
    // that job (job path) — NOT take the install-gate resume path, which has no
    // pending workflow context and would fail the run.
    const workflowHold = { ...pendingHold, hold_scope: 'workflow', job_id: 'release' };
    const store = makeStore({
      getById: vi.fn().mockResolvedValue(workflowHold),
      listDecisions: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ approver_user_id: 'u-alice', decision: 'approve' }]),
      release: vi.fn().mockResolvedValue({
        holdId: 'hr-1',
        runId: 'run-1',
        jobId: 'release',
        scope: 'workflow',
        stepIndex: null,
        triggerSource: 'explicit',
      }),
    });
    const onWorkflowRelease = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(store, { onWorkflowRelease });
    const result = await applyDecision(deps, {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'approve',
    });
    expect(result.status).toBe('released');
    expect(deps.onJobRelease).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'workflow', jobId: 'release', triggerSource: 'explicit' }),
    );
    expect(onWorkflowRelease).not.toHaveBeenCalled();
  });

  it('cancels the run via onWorkflowReject when a workflow-scoped hold is rejected', async () => {
    const workflowHold = { ...pendingHold, hold_scope: 'workflow', job_id: '__install__CI' };
    const store = makeStore({ getById: vi.fn().mockResolvedValue(workflowHold) });
    const onWorkflowReject = vi.fn().mockResolvedValue(undefined);
    const result = await applyDecision(makeDeps(store, { onWorkflowReject }), {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'reject',
      reason: 'no',
    });
    expect(result.status).toBe('rejected');
    expect(store.reject).toHaveBeenCalledWith('org-1', 'hr-1', 'no');
    expect(onWorkflowReject).toHaveBeenCalledWith('run-1');
  });

  it('blocks self-approval when disabled', async () => {
    const store = makeStore({ getById: vi.fn().mockResolvedValue(pendingHold) });
    const deps = makeDeps(store, {
      allowSelfApproval: false,
      resolveTriggererSub: vi.fn().mockResolvedValue('u-alice'),
    });
    const result = await applyDecision(deps, {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'approve',
    });
    expect(result.status).toBe('ineligible');
  });

  it('records and rejects on a reject decision', async () => {
    const store = makeStore({ getById: vi.fn().mockResolvedValue(pendingHold) });
    const result = await applyDecision(makeDeps(store), {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'reject',
      reason: 'not ready',
    });
    expect(result.status).toBe('rejected');
    expect(store.recordDecision).toHaveBeenCalledWith('hr-1', {
      approverSub: 'u-alice',
      decision: 'reject',
    });
    expect(store.reject).toHaveBeenCalledWith('org-1', 'hr-1', 'not ready');
  });

  it('notifies onStepReject when a step-scoped hold is rejected', async () => {
    const stepHold = { ...pendingHold, hold_scope: 'step', step_index: 2 };
    const store = makeStore({ getById: vi.fn().mockResolvedValue(stepHold) });
    const onStepReject = vi.fn().mockResolvedValue(undefined);
    const result = await applyDecision(makeDeps(store, { onStepReject }), {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'reject',
      reason: 'no',
    });
    expect(result.status).toBe('rejected');
    expect(onStepReject).toHaveBeenCalledWith('hr-1', 'no');
  });

  it('does not call onStepReject for a job-scoped reject', async () => {
    const store = makeStore({ getById: vi.fn().mockResolvedValue(pendingHold) });
    const onStepReject = vi.fn();
    await applyDecision(makeDeps(store, { onStepReject }), {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'reject',
    });
    expect(onStepReject).not.toHaveBeenCalled();
  });
});
