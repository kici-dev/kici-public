/**
 * Tests for the shared approve/reject applier. Exercises eligibility gating,
 * multi-clause accumulation, the release+resume path for job scope, the step
 * branch, and rejection.
 */
import { describe, it, expect, vi } from 'vitest';

import { installGateJobId, SECURITY_HOLD_JOB_IDS } from '@kici-dev/engine';

import { applyDecision, type ApplyDecisionDeps } from './apply-decision.js';
import type { TeamMembershipLookup } from './approval-resolver.js';
import { HoldOutcome } from '../pipeline/security-hold-check.js';

const leadsLookup: TeamMembershipLookup = (team) =>
  team === 'leads' ? new Set(['u-alice', 'u-bob']) : new Set();

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    getById: vi.fn(),
    listDecisions: vi.fn().mockResolvedValue([]),
    recordDecision: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    release: vi.fn(),
    recordAndRelease: vi.fn(),
    recordAndReject: vi.fn().mockResolvedValue({}),
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

/**
 * Apply a decision AND wait for its post-commit consequence.
 *
 * `applyDecision` deliberately returns at the durable record and hands the
 * consequence back unawaited (see `ApplyDecisionResult.consequence`), so a test
 * asserting a resume, a settle, or a reject delegate has to join it. Every case
 * below that asserts a side effect of the decision uses this; the two cases that
 * assert the DETACHMENT itself call `applyDecision` directly.
 */
async function applyAndSettle(
  ...args: Parameters<typeof applyDecision>
): Promise<Awaited<ReturnType<typeof applyDecision>>> {
  const result = await applyDecision(...args);
  await result.consequence;
  return result;
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
    const result = await applyAndSettle(makeDeps(store), {
      heldRunId: 'hr-x',
      actorSub: 'u-alice',
      decision: 'approve',
    });
    expect(result.status).toBe('not-found');
    expect(result.accepted).toBe(false);
  });

  it('rejects an ineligible approver', async () => {
    const store = makeStore({ getById: vi.fn().mockResolvedValue(pendingHold) });
    const result = await applyAndSettle(makeDeps(store), {
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
      // Eligibility read returns no prior decisions; the prospective approve is
      // evaluated in memory, so the satisfying path takes the atomic method.
      listDecisions: vi.fn().mockResolvedValue([]),
      recordAndRelease: vi.fn().mockResolvedValue({
        holdId: 'hr-1',
        runId: 'run-1',
        jobId: 'deploy',
        scope: 'job',
        stepIndex: null,
        triggerSource: 'explicit',
      }),
    });
    const deps = makeDeps(store);
    const result = await applyAndSettle(deps, {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'approve',
    });

    expect(result.status).toBe('released');
    expect(store.recordAndRelease).toHaveBeenCalledTimes(1);
    expect(store.recordDecision).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
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
      listDecisions: vi.fn().mockResolvedValue([]),
    });
    const result = await applyAndSettle(makeDeps(store), {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'approve',
    });
    expect(result.status).toBe('pending');
    expect(result.remainingClauses).toBe(1);
    // A non-satisfying approve is a safe lone INSERT — no atomic release.
    expect(store.recordDecision).toHaveBeenCalledTimes(1);
    expect(store.recordAndRelease).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });

  it('routes a step-scoped release to onStepRelease', async () => {
    const stepHold = { ...pendingHold, hold_scope: 'step', step_index: 2 };
    const store = makeStore({
      getById: vi.fn().mockResolvedValue(stepHold),
      listDecisions: vi.fn().mockResolvedValue([]),
      recordAndRelease: vi.fn().mockResolvedValue({
        holdId: 'hr-1',
        runId: 'run-1',
        jobId: 'deploy',
        scope: 'step',
        stepIndex: 2,
        triggerSource: 'explicit',
      }),
    });
    const deps = makeDeps(store);
    const result = await applyAndSettle(deps, {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'approve',
    });
    expect(result.status).toBe('released');
    expect(deps.onStepRelease).toHaveBeenCalledTimes(1);
    expect(deps.onJobRelease).not.toHaveBeenCalled();
  });

  it('routes a workflow-scoped install-gate release to onWorkflowRelease', async () => {
    const workflowHold = { ...pendingHold, hold_scope: 'workflow', job_id: installGateJobId('CI') };
    const store = makeStore({
      getById: vi.fn().mockResolvedValue(workflowHold),
      listDecisions: vi.fn().mockResolvedValue([]),
      recordAndRelease: vi.fn().mockResolvedValue({
        holdId: 'hr-1',
        runId: 'run-1',
        jobId: installGateJobId('CI'),
        scope: 'workflow',
        stepIndex: null,
        // Install-gate holds are environment-triggered.
        triggerSource: 'context',
      }),
    });
    const onWorkflowRelease = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(store, { onWorkflowRelease });
    const result = await applyAndSettle(deps, {
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
      listDecisions: vi.fn().mockResolvedValue([]),
      recordAndRelease: vi.fn().mockResolvedValue({
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
    const result = await applyAndSettle(deps, {
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
    const workflowHold = { ...pendingHold, hold_scope: 'workflow', job_id: installGateJobId('CI') };
    const store = makeStore({ getById: vi.fn().mockResolvedValue(workflowHold) });
    const onWorkflowReject = vi.fn().mockResolvedValue(true);
    const result = await applyAndSettle(makeDeps(store, { onWorkflowReject }), {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'reject',
      reason: 'no',
    });
    expect(result.status).toBe('rejected');
    expect(store.recordAndReject).toHaveBeenCalledWith(
      'org-1',
      'hr-1',
      expect.objectContaining({ approverSub: 'u-alice', decision: 'reject' }),
      'no',
    );
    // The rejecter's own reason travels with the runId and becomes the run's
    // cancellation reason. Dropping it left the wiring site to invent one, and
    // the string it invented named the install gate — so a rejected fork PR was
    // cancelled as "Workflow install gate rejected".
    // The hold row travels beside it: it is what tells the handler an install
    // gate (no `KiCI Security` check) from the trust policy's PR-wide hold or
    // an SDK workflow-level `requireApproval` (each with one to complete).
    expect(onWorkflowReject).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 'run-1', job_id: installGateJobId('CI') }),
      'no',
    );
  });

  it('passes no reason through when the rejecter supplied none', async () => {
    // The control: the reason is forwarded, not synthesised here. A handler
    // that received a value for a reasonless reject would mean this layer had
    // started naming the cause itself.
    const workflowHold = { ...pendingHold, hold_scope: 'workflow', job_id: installGateJobId('CI') };
    const store = makeStore({ getById: vi.fn().mockResolvedValue(workflowHold) });
    const onWorkflowReject = vi.fn().mockResolvedValue(true);
    await applyAndSettle(makeDeps(store, { onWorkflowReject }), {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'reject',
    });
    expect(onWorkflowReject).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 'run-1', job_id: installGateJobId('CI') }),
      undefined,
    );
  });

  it('blocks self-approval when disabled', async () => {
    const store = makeStore({ getById: vi.fn().mockResolvedValue(pendingHold) });
    const deps = makeDeps(store, {
      allowSelfApproval: false,
      resolveTriggererSub: vi.fn().mockResolvedValue('u-alice'),
    });
    const result = await applyAndSettle(deps, {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'approve',
    });
    expect(result.status).toBe('ineligible');
  });

  it('records and rejects atomically on a reject decision (recordAndReject, not recordDecision + reject)', async () => {
    const store = makeStore({ getById: vi.fn().mockResolvedValue(pendingHold) });
    const result = await applyAndSettle(makeDeps(store), {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'reject',
      reason: 'not ready',
    });
    expect(result.status).toBe('rejected');
    expect(store.recordAndReject).toHaveBeenCalledWith(
      'org-1',
      'hr-1',
      expect.objectContaining({ approverSub: 'u-alice', decision: 'reject' }),
      'not ready',
    );
    expect(store.recordDecision).not.toHaveBeenCalled();
    expect(store.reject).not.toHaveBeenCalled();
  });

  it('notifies onStepReject when a step-scoped hold is rejected', async () => {
    const stepHold = { ...pendingHold, hold_scope: 'step', step_index: 2 };
    const store = makeStore({ getById: vi.fn().mockResolvedValue(stepHold) });
    const onStepReject = vi.fn().mockResolvedValue(undefined);
    const result = await applyAndSettle(makeDeps(store, { onStepReject }), {
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
    await applyAndSettle(makeDeps(store, { onStepReject }), {
      heldRunId: 'hr-1',
      actorSub: 'u-alice',
      decision: 'reject',
    });
    expect(onStepReject).not.toHaveBeenCalled();
  });

  /**
   * The hold's row leaves `pending` here, and `listOverdue` only ever sees
   * pending rows — so if this applier does not terminalize the hold's
   * `KiCI Security` check, nothing downstream ever will.
   */
  describe('terminalizes the security check of the hold it just ended', () => {
    function releasingStore() {
      return makeStore({
        getById: vi.fn().mockResolvedValue(pendingHold),
        recordAndRelease: vi.fn().mockResolvedValue({
          holdId: 'hr-1',
          runId: 'run-1',
          jobId: 'deploy',
          scope: 'job',
          stepIndex: null,
          triggerSource: 'context',
        }),
      });
    }

    it('settles an approved JOB-scoped hold, before the resume', async () => {
      // Before the resume, not after: a replayed dispatch can hold again and
      // post its own pending status, and that pending status has to be the last
      // write rather than this `success`.
      const order: string[] = [];
      const settleSecurityCheck = vi.fn().mockImplementation(async () => {
        order.push('settle');
        return true;
      });
      const onJobRelease = vi.fn().mockImplementation(async () => {
        order.push('resume');
      });

      const result = await applyAndSettle(
        makeDeps(releasingStore(), { settleSecurityCheck, onJobRelease }),
        { heldRunId: 'hr-1', actorSub: 'u-alice', decision: 'approve' },
      );

      expect(result.status).toBe('released');
      expect(settleSecurityCheck).toHaveBeenCalledWith({
        hold: pendingHold,
        outcome: HoldOutcome.Approved,
        actorSub: 'u-alice',
      });
      expect(order).toEqual(['settle', 'resume']);
    });

    it('does not settle an approve that has not satisfied its clauses', async () => {
      // The control: only the release settles. A hold still awaiting a second
      // approver is still held, and a `success` here would say otherwise.
      const store = makeStore({
        getById: vi.fn().mockResolvedValue({
          ...pendingHold,
          approval_requirement: {
            clauses: [{ user: 'u-alice' }, { user: 'u-bob' }],
            expiresAt: 'x',
            reason: 'r',
          },
        }),
      });
      const settleSecurityCheck = vi.fn().mockResolvedValue(true);

      const result = await applyAndSettle(makeDeps(store, { settleSecurityCheck }), {
        heldRunId: 'hr-1',
        actorSub: 'u-alice',
        decision: 'approve',
      });

      expect(result.status).toBe('pending');
      expect(settleSecurityCheck).not.toHaveBeenCalled();
    });

    it('settles a rejected JOB-scoped hold, which has no delegate at all', async () => {
      const store = makeStore({ getById: vi.fn().mockResolvedValue(pendingHold) });
      const settleSecurityCheck = vi.fn().mockResolvedValue(true);
      const onWorkflowReject = vi.fn().mockResolvedValue(true);

      await applyAndSettle(makeDeps(store, { settleSecurityCheck, onWorkflowReject }), {
        heldRunId: 'hr-1',
        actorSub: 'u-alice',
        decision: 'reject',
        reason: 'no',
      });

      expect(onWorkflowReject).not.toHaveBeenCalled();
      expect(settleSecurityCheck).toHaveBeenCalledWith({
        hold: pendingHold,
        outcome: HoldOutcome.Rejected,
        actorSub: 'u-alice',
        reason: 'no',
      });
    });

    it('leaves a workflow-scoped reject to the delegate that wrote the check', async () => {
      const workflowHold = {
        ...pendingHold,
        hold_scope: 'workflow',
        job_id: SECURITY_HOLD_JOB_IDS.fork_pr,
      };
      const store = makeStore({ getById: vi.fn().mockResolvedValue(workflowHold) });
      const settleSecurityCheck = vi.fn().mockResolvedValue(true);
      const onWorkflowReject = vi.fn().mockResolvedValue(true);

      await applyAndSettle(makeDeps(store, { settleSecurityCheck, onWorkflowReject }), {
        heldRunId: 'hr-1',
        actorSub: 'u-alice',
        decision: 'reject',
      });

      expect(onWorkflowReject).toHaveBeenCalledTimes(1);
      expect(settleSecurityCheck).not.toHaveBeenCalled();
    });

    it('settles a workflow-scoped reject the delegate did NOT write a check for', async () => {
      // The suppression is bound to a check having been written, not to the
      // delegate resolving — an install-gate hold and a still-contended commit
      // both come back `false`, and the settler declines again for the same
      // reason rather than fabricating one.
      const workflowHold = {
        ...pendingHold,
        hold_scope: 'workflow',
        job_id: installGateJobId('CI'),
      };
      const store = makeStore({ getById: vi.fn().mockResolvedValue(workflowHold) });
      const settleSecurityCheck = vi.fn().mockResolvedValue(false);
      const onWorkflowReject = vi.fn().mockResolvedValue(false);

      await applyAndSettle(makeDeps(store, { settleSecurityCheck, onWorkflowReject }), {
        heldRunId: 'hr-1',
        actorSub: 'u-alice',
        decision: 'reject',
      });

      expect(onWorkflowReject).toHaveBeenCalledTimes(1);
      expect(settleSecurityCheck).toHaveBeenCalledTimes(1);
    });

    it('still settles the check when the workflow-reject delegate throws', async () => {
      // The reject has already landed in the database by the time the delegate
      // runs, and the delegate is the only thing that would have reported it on
      // the commit. Letting its throw escape aborted the applier and stranded
      // the pending check — the `/kici reject` handler catches the same call.
      const workflowHold = {
        ...pendingHold,
        hold_scope: 'workflow',
        job_id: SECURITY_HOLD_JOB_IDS.fork_pr,
      };
      const store = makeStore({ getById: vi.fn().mockResolvedValue(workflowHold) });
      const settleSecurityCheck = vi.fn().mockResolvedValue(true);
      const onWorkflowReject = vi.fn().mockRejectedValue(new Error('run cancel failed'));

      const result = await applyAndSettle(
        makeDeps(store, { settleSecurityCheck, onWorkflowReject }),
        { heldRunId: 'hr-1', actorSub: 'u-alice', decision: 'reject' },
      );

      expect(result).toMatchObject({ accepted: true, status: 'rejected' });
      expect(onWorkflowReject).toHaveBeenCalledTimes(1);
      expect(settleSecurityCheck).toHaveBeenCalledTimes(1);
    });

    it('attributes a delegated reject the same way whichever path settled it', async () => {
      // `rejectWorkflow` builds its summary with no actor, so the settle that
      // stands in for a throwing delegate must not name one either. Otherwise
      // the same rejection reads "Rejected by …" only when the delegate
      // happened to throw — a difference the rejecter never made.
      const workflowHold = {
        ...pendingHold,
        hold_scope: 'workflow',
        job_id: SECURITY_HOLD_JOB_IDS.fork_pr,
      };
      const store = makeStore({ getById: vi.fn().mockResolvedValue(workflowHold) });
      const settleSecurityCheck = vi.fn().mockResolvedValue(true);
      const onWorkflowReject = vi.fn().mockRejectedValue(new Error('run cancel failed'));

      await applyAndSettle(makeDeps(store, { settleSecurityCheck, onWorkflowReject }), {
        heldRunId: 'hr-1',
        actorSub: 'u-alice',
        decision: 'reject',
        reason: 'no',
      });

      expect(settleSecurityCheck).toHaveBeenCalledWith({
        hold: workflowHold,
        outcome: HoldOutcome.Rejected,
        reason: 'no',
      });
      expect(settleSecurityCheck.mock.calls[0][0]).not.toHaveProperty('actorSub');
    });

    it('names the rejecter on a hold that had no delegate to match', async () => {
      // The counterpart of the case above, so the omission is bound to standing
      // in for a delegate rather than to workflow scope. A job-scoped reject is
      // never delegated, so this settle is the only writer of that summary and
      // there is no other rendering for it to disagree with.
      const store = makeStore({ getById: vi.fn().mockResolvedValue(pendingHold) });
      const settleSecurityCheck = vi.fn().mockResolvedValue(true);

      await applyAndSettle(makeDeps(store, { settleSecurityCheck }), {
        heldRunId: 'hr-1',
        actorSub: 'u-alice',
        decision: 'reject',
      });

      expect(settleSecurityCheck.mock.calls[0][0]).toMatchObject({ actorSub: 'u-alice' });
    });
  });
  /**
   * The applier answers at the durable record, not at the consequence. The
   * defect this closes: releasing a workflow-scoped fork-PR hold replayed the
   * whole stored dispatch context before acking, which took 9.8 s inside the
   * Platform's 10 s relay budget — so an approval that fully succeeded answered
   * 504, and the operator's natural retry hit "already resolved".
   */
  describe('answers at the durable record, not at the consequence', () => {
    function releasingStore() {
      return makeStore({
        getById: vi.fn().mockResolvedValue(pendingHold),
        recordAndRelease: vi.fn().mockResolvedValue({
          holdId: 'hr-1',
          runId: 'run-1',
          jobId: 'deploy',
          scope: 'job',
          stepIndex: null,
          triggerSource: 'explicit',
        }),
      });
    }

    it('resolves before a slow resume finishes, and the resume still runs', async () => {
      let releaseResume: (() => void) | undefined;
      const onJobRelease = vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseResume = resolve;
          }),
      );
      const store = releasingStore();

      const result = await applyDecision(makeDeps(store, { onJobRelease }), {
        heldRunId: 'hr-1',
        actorSub: 'u-alice',
        decision: 'approve',
      });

      // Answered while the resume is still in flight — the whole point.
      expect(result.status).toBe('released');
      expect(store.recordAndRelease).toHaveBeenCalledTimes(1);
      expect(onJobRelease).toHaveBeenCalledTimes(1);
      expect(releaseResume).toBeDefined();

      // A row flip without a dispatch looks like it works and does nothing, so
      // the consequence is joined and asserted rather than assumed.
      releaseResume!();
      await expect(result.consequence).resolves.toEqual({ ok: true });
    });

    it('reports a throwing resume as a failed consequence instead of failing the answer', async () => {
      const onJobRelease = vi.fn().mockRejectedValue(new Error('resume exploded'));

      const result = await applyDecision(makeDeps(releasingStore(), { onJobRelease }), {
        heldRunId: 'hr-1',
        actorSub: 'u-alice',
        decision: 'approve',
      });

      // The decision landed: the approval is durable whatever the resume did.
      expect(result.accepted).toBe(true);
      expect(result.status).toBe('released');
      // And the failure is not swallowed — it is reported on the handle, which
      // is what each caller turns into its `error` access-log entry.
      await expect(result.consequence).resolves.toEqual({
        ok: false,
        error: 'resume exploded',
      });
    });

    it('carries no consequence for a decision that changed nothing', async () => {
      // The control: only a terminal decision has a consequence. A non-satisfying
      // approve leaves the hold pending, so a caller that audits on the handle
      // must still audit this one immediately rather than waiting forever.
      const twoClauseHold = {
        ...pendingHold,
        approval_requirement: {
          clauses: [{ team: 'leads' }, { user: 'u-cto' }],
          expiresAt: 'x',
          reason: 'r',
        },
      };
      const pendingResult = await applyDecision(
        makeDeps(makeStore({ getById: vi.fn().mockResolvedValue(twoClauseHold) })),
        { heldRunId: 'hr-1', actorSub: 'u-alice', decision: 'approve' },
      );
      expect(pendingResult.status).toBe('pending');
      expect(pendingResult.consequence).toBeUndefined();

      const missing = await applyDecision(
        makeDeps(makeStore({ getById: vi.fn().mockResolvedValue(null) })),
        { heldRunId: 'hr-x', actorSub: 'u-alice', decision: 'approve' },
      );
      expect(missing.status).toBe('not-found');
      expect(missing.consequence).toBeUndefined();
    });

    it('detaches a reject the same way, and still runs its delegate', async () => {
      // Same shape, same reason: rejecting a workflow-scoped hold cancels the
      // run and completes a provider check run per job the held dispatch had
      // queued, which is unbounded work behind the same relay budget.
      const workflowHold = {
        ...pendingHold,
        hold_scope: 'workflow',
        job_id: installGateJobId('CI'),
      };
      let releaseReject: ((posted: boolean) => void) | undefined;
      const onWorkflowReject = vi.fn().mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            releaseReject = resolve;
          }),
      );
      const store = makeStore({ getById: vi.fn().mockResolvedValue(workflowHold) });

      const result = await applyDecision(makeDeps(store, { onWorkflowReject }), {
        heldRunId: 'hr-1',
        actorSub: 'u-alice',
        decision: 'reject',
        reason: 'no',
      });

      expect(result.status).toBe('rejected');
      expect(store.recordAndReject).toHaveBeenCalledTimes(1);
      expect(releaseReject).toBeDefined();

      releaseReject!(true);
      await expect(result.consequence).resolves.toEqual({ ok: true });
    });
  });
});
