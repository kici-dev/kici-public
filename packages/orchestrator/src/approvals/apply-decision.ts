/**
 * Shared approve/reject applier — the single code path behind both the
 * dashboard WS handler and the `kici` CLI HTTP route, so the authorization +
 * resume story is identical regardless of the surface.
 *
 * Flow for an approve:
 *   1. Load the hold + its recorded decisions.
 *   2. Build the team-membership lookup and run `canApprove` (eligibility +
 *      self-approval gate). Ineligible actors are rejected with a clear reason.
 *   3. Record the decision in `held_run_approvals`.
 *   4. Re-evaluate. If all clauses are satisfied, `release()` the hold and
 *      resume the element (re-dispatch for job/workflow; the agent bridge for
 *      step scope — wired by the caller via `onStepRelease`).
 *
 * A reject records the decision and `reject()`s the hold (failing the element).
 */
import {
  ApprovalDecision,
  HoldScope,
  TriggerSource,
  type ApprovalRequirement,
} from '@kici-dev/engine';

import type { HeldRunStore, ReleaseSignal } from '../environments/held-runs.js';
import {
  canApprove,
  evaluate,
  isActorEligibleForClause,
  type RecordedDecision,
  type TeamMembershipLookup,
} from './approval-resolver.js';

/** Outcome of applying a decision. */
export interface ApplyDecisionResult {
  /** Whether the decision was accepted (recorded). */
  accepted: boolean;
  /** Human-readable status: 'released' | 'rejected' | 'pending' | 'ineligible' | 'not-found'. */
  status: 'released' | 'rejected' | 'pending' | 'ineligible' | 'not-found';
  /** When still pending, how many clauses remain unsatisfied. */
  remainingClauses?: number;
  /** When ineligible/not-found, a reason for the caller to surface. */
  reason?: string;
  /** The release signal, when the element was released (for the caller to resume). */
  release?: ReleaseSignal;
}

/** Dependencies injected into `applyDecision` (testable in isolation). */
export interface ApplyDecisionDeps {
  orgId: string;
  store: HeldRunStore;
  /** Team name → member user ids (from the Plan-1 trust-policy cache). */
  teamMembershipLookup: TeamMembershipLookup;
  /** Whether the run triggerer may self-approve (org_settings.allow_self_approval). */
  allowSelfApproval: boolean;
  /** Resolve the Keycloak sub of the user who triggered a run (for the self-approval gate). */
  resolveTriggererSub: (runId: string) => Promise<string | undefined>;
  /** Called when a job hold is released — re-dispatch the element. */
  onJobRelease: (signal: ReleaseSignal) => Promise<void>;
  /** Called when a step hold is released — notify the waiting agent (approved). */
  onStepRelease?: (signal: ReleaseSignal) => Promise<void>;
  /**
   * Called when a workflow-scoped hold is released (install gate approved) —
   * rebuild the dispatch context and resume the workflow from the install gate.
   */
  onWorkflowRelease?: (signal: ReleaseSignal) => Promise<void>;
  /**
   * Called when a step-scoped hold is rejected — notify the waiting agent so it
   * fails the step instead of blocking until expiry. Carries the holdId.
   */
  onStepReject?: (heldRunId: string, reason?: string) => Promise<void> | void;
  /**
   * Called when a workflow-scoped hold is rejected (install gate rejected) —
   * cancel the run and drop the pending workflow context. Carries the runId.
   */
  onWorkflowReject?: (runId: string) => Promise<void>;
}

function toRecorded(rows: { approver_user_id: string; decision: string }[]): RecordedDecision[] {
  return rows.map((r) => ({
    approver_user_id: r.approver_user_id,
    decision: r.decision === ApprovalDecision.enum.reject ? 'reject' : 'approve',
  }));
}

/** Apply a single approve/reject decision to a hold. */
export async function applyDecision(
  deps: ApplyDecisionDeps,
  args: { heldRunId: string; actorSub: string; decision: ApprovalDecision; reason?: string },
): Promise<ApplyDecisionResult> {
  const { store, orgId, teamMembershipLookup } = deps;
  const hold = await store.getById(orgId, args.heldRunId);
  if (!hold || hold.status !== 'pending') {
    return {
      accepted: false,
      status: 'not-found',
      reason: 'held run not found or already resolved',
    };
  }

  const requirement = normalizeRequirement(hold.approval_requirement);

  if (args.decision === ApprovalDecision.enum.reject) {
    await store.recordDecision(args.heldRunId, {
      approverSub: args.actorSub,
      decision: ApprovalDecision.enum.reject,
    });
    await store.reject(orgId, args.heldRunId, args.reason);
    // Step-scoped rejects must notify the waiting agent so it fails the step
    // immediately rather than blocking until the hold expires.
    if (hold.hold_scope === HoldScope.enum.step) {
      await deps.onStepReject?.(args.heldRunId, args.reason);
    } else if (hold.hold_scope === HoldScope.enum.workflow) {
      // Workflow-scoped rejects cancel the run and drop the pending context.
      await deps.onWorkflowReject?.(hold.run_id);
    }
    return { accepted: true, status: 'rejected' };
  }

  const existing = toRecorded(await store.listDecisions(args.heldRunId));
  const triggererSub = (await deps.resolveTriggererSub(hold.run_id)) ?? '';
  const eligible = canApprove(args.actorSub, requirement, existing, teamMembershipLookup, {
    triggererSub,
    allowSelfApproval: deps.allowSelfApproval,
  });
  if (!eligible) {
    return {
      accepted: false,
      status: 'ineligible',
      reason: 'actor is not eligible to approve this hold (or self-approval is disabled)',
    };
  }

  // Persist which requirement clauses this actor satisfies, so the dashboard
  // can render per-clause attribution without the team-membership lookup.
  const clausesSatisfied = requirement.clauses.filter((clause) =>
    isActorEligibleForClause(args.actorSub, clause, teamMembershipLookup),
  );
  await store.recordDecision(args.heldRunId, {
    approverSub: args.actorSub,
    decision: ApprovalDecision.enum.approve,
    clausesSatisfied,
  });

  const after = toRecorded(await store.listDecisions(args.heldRunId));
  const result = evaluate(requirement, after, teamMembershipLookup);
  if (!result.satisfied) {
    const remaining = result.perClause.filter((c) => !c.satisfied).length;
    return { accepted: true, status: 'pending', remainingClauses: remaining };
  }

  const signal = await store.release(orgId, args.heldRunId);
  if (signal.scope === HoldScope.enum.step) {
    await deps.onStepRelease?.(signal);
  } else if (
    signal.scope === HoldScope.enum.workflow &&
    signal.triggerSource === TriggerSource.enum.environment
  ) {
    // Only the workflow install gate (env approval / wait-timer / concurrency)
    // resumes by rebuilding the workflow dispatch context. An explicit
    // workflow-scoped `requireApproval` hold holds a real root job, so it
    // resumes through the same job re-dispatch path as a job-scoped hold.
    await deps.onWorkflowRelease?.(signal);
  } else {
    await deps.onJobRelease(signal);
  }
  return { accepted: true, status: 'released', release: signal };
}

/** Coerce the stored requirement (jsonb or object) into an `ApprovalRequirement`. */
function normalizeRequirement(raw: unknown): ApprovalRequirement {
  if (raw && typeof raw === 'object' && 'clauses' in (raw as Record<string, unknown>)) {
    return raw as ApprovalRequirement;
  }
  // Legacy rows without a requirement: treat as "any single approval".
  return { clauses: [], expiresAt: new Date().toISOString(), reason: '' };
}
