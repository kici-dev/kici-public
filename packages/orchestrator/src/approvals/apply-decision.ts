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
 *
 * **A decision answers at its durable record, not at its consequence.** The
 * transaction that flips the hold row — `recordAndRelease` for the satisfying
 * approve, `recordAndReject` for the reject — is the commit point AND the
 * serialization point: both are `WHERE status = 'pending'`, so a second decider
 * loses there, not at the answer. Everything that follows is consequence, and
 * its cost is unbounded: releasing a workflow-scoped hold replays the whole
 * stored dispatch context (re-evaluating triggers, re-fetching the lock file,
 * re-routing jobs), and rejecting one completes a provider check run per job the
 * held dispatch had queued. So the applier returns as soon as the decision is
 * durable and hands the consequence back as `ApplyDecisionResult.consequence` —
 * started, never awaited, and never rejecting. Callers with a waiting HTTP or
 * relay client answer immediately; the reasons are in that field's own doc.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import { ApprovalDecision, HoldScope, type ApprovalRequirement } from '@kici-dev/engine';

import type { HeldRun } from '../db/types.js';
import { HoldOutcome } from '../pipeline/security-hold-check.js';
import type { HeldRunStore, ReleaseSignal } from '../contexts/held-runs.js';
import { routeRelease } from './resume-router.js';
import {
  canApprove,
  evaluate,
  isActorEligibleForClause,
  type RecordedDecision,
  type TeamMembershipLookup,
} from './approval-resolver.js';

const logger = createLogger({ prefix: 'apply-decision' });

/** Whether a decision's post-commit consequence ran to completion. */
export interface DecisionConsequenceResult {
  /** True when the whole consequence chain ran; false when a step of it threw. */
  ok: boolean;
  /** The failure message, when `ok` is false. */
  error?: string;
}

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
  /**
   * The decision's post-commit consequence — already running, deliberately not
   * awaited by the applier. Present on `released` and `rejected`, absent on
   * every outcome that changed nothing (`pending`, `ineligible`, `not-found`).
   *
   * It NEVER rejects: a throw anywhere in the chain is logged and surfaces as
   * `{ ok: false, error }`, so a caller may drop it on the floor without
   * risking an unhandled rejection. A caller that answers a waiting client
   * answers without awaiting this, and attaches its audit record to it instead
   * — the record then carries the consequence's real outcome rather than a
   * guess. A caller that needs the consequence finished before it continues
   * (a test, a sequential sweep) awaits it.
   *
   * The consequence is where an approve was spending nine-plus seconds behind a
   * ten-second relay budget, answering 504 on an approval that had already
   * landed. It is not a stronger answer for having been awaited: the resume it
   * runs is the same dispatch the original webhook delivery ran without any
   * client waiting on it, `dispatchMatchedWorkflow` returning says only that
   * jobs were routed rather than that any of them ran, and `resumeWorkflow`
   * already reports its own failures on the run row and on the provider's check
   * runs rather than through this return value.
   */
  consequence?: Promise<DecisionConsequenceResult>;
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
   * Called when a workflow-scoped hold is rejected — cancel the run and drop
   * the pending workflow context. Carries the whole hold row and the rejecter's
   * own reason, which becomes the run's cancellation reason: the callers serve
   * the install gate, the org trust policy's PR-wide hold and the SDK's
   * workflow-level `requireApproval` alike, so a reason invented at the wiring
   * site would misattribute one of them.
   *
   * The row is what tells those apart — only some of them posted a pending
   * `KiCI Security` check, and only those have one to complete. Resolves to
   * whether a terminal security check was WRITTEN, so this applier suppresses
   * its own post only when one actually landed.
   */
  onWorkflowReject?: (hold: HeldRun, reason?: string) => Promise<boolean>;
  /**
   * Terminalize the `KiCI Security` check a just-ended hold posted, for every
   * hold this applier ends that `onWorkflowReject` did not already report.
   *
   * Without it a job-scoped security hold answered from the dashboard strands
   * its check forever: the row leaves `pending`, so the stale detector's
   * approval-window sweep — which only ever sees pending rows — can no longer
   * reach it. Optional so an orchestrator with no provider wiring degrades to
   * flip-and-resume rather than failing the decision.
   *
   * `actorSub` is the deciding actor's opaque subject id, which is what this
   * applier has and NOT something a contributor can read. Resolving it to a
   * display name — or dropping the attribution when it resolves to none — is
   * the wiring site's job, because only that site holds the org's identity
   * directory. Omitted entirely where the summary must match one a delegate
   * built without it; see the reject arm below.
   */
  settleSecurityCheck?: (args: {
    hold: HeldRun;
    outcome: HoldOutcome;
    actorSub?: string | undefined;
    reason?: string | undefined;
  }) => Promise<boolean>;
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
    // Atomic: record the reject decision AND flip the hold to rejected in one
    // transaction, so a crash between the two writes cannot leave an orphaned
    // reject decision that poisons evaluate() while the hold stays pending.
    await store.recordAndReject(
      orgId,
      args.heldRunId,
      { approverSub: args.actorSub, decision: ApprovalDecision.enum.reject },
      args.reason,
    );
    // The reject is durable here; the rest is consequence. See
    // `ApplyDecisionResult.consequence` for why it is not awaited.
    return {
      accepted: true,
      status: 'rejected',
      consequence: runConsequence(hold, () => rejectConsequence(deps, hold, args)),
    };
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

  // Evaluate the prospective decision set (existing + this approve) in memory.
  // Only the *satisfying* approve needs the record + release to be atomic; a
  // non-satisfying approve is a safe lone INSERT (a recorded approve with the
  // hold still pending is a valid steady state — no orphan to poison anything).
  const prospective: RecordedDecision[] = [
    ...existing,
    { approver_user_id: args.actorSub, decision: 'approve' },
  ];
  const result = evaluate(requirement, prospective, teamMembershipLookup);
  if (!result.satisfied) {
    await store.recordDecision(args.heldRunId, {
      approverSub: args.actorSub,
      decision: ApprovalDecision.enum.approve,
      clausesSatisfied,
    });
    const remaining = result.perClause.filter((c) => !c.satisfied).length;
    return { accepted: true, status: 'pending', remainingClauses: remaining };
  }

  // Atomic: record the satisfying approve AND release the hold in one
  // transaction, so a crash between the two writes cannot leave the hold
  // pending-but-satisfied (which makes canApprove() return false for everyone).
  // This transaction is the commit point — see `ApplyDecisionResult.consequence`.
  const signal = await store.recordAndRelease(orgId, args.heldRunId, {
    approverSub: args.actorSub,
    decision: ApprovalDecision.enum.approve,
    clausesSatisfied,
  });
  return {
    accepted: true,
    status: 'released',
    release: signal,
    consequence: runConsequence(hold, () => approveConsequence(deps, hold, signal, args.actorSub)),
  };
}

/**
 * Run one decision's post-commit consequence, converting any throw into a
 * logged `{ ok: false }`.
 *
 * The returned promise is what `ApplyDecisionResult.consequence` hands back, so
 * it must never reject: its callers are free to leave it unawaited, and an
 * unawaited rejection would take the orchestrator's process down.
 */
function runConsequence(
  hold: HeldRun,
  body: () => Promise<void>,
): Promise<DecisionConsequenceResult> {
  return body()
    .then(() => ({ ok: true }) as DecisionConsequenceResult)
    .catch((err) => {
      const error = toErrorMessage(err);
      logger.error('Failed to apply the consequence of a recorded held-run decision', {
        heldRunId: hold.id,
        runId: hold.run_id,
        jobId: hold.job_id,
        holdScope: hold.hold_scope,
        error,
      });
      return { ok: false, error };
    });
}

/** The post-commit consequence of a satisfying approve: settle, then resume. */
async function approveConsequence(
  deps: ApplyDecisionDeps,
  hold: HeldRun,
  signal: ReleaseSignal,
  actorSub: string,
): Promise<void> {
  // BEFORE the resume, not after. A replayed workflow dispatch can hold again
  // and post its own pending `KiCI Security` status; settling afterwards would
  // overwrite that pending status with this `success` and show a green security
  // check over work that is held. In this order the replay's pending post lands
  // last and wins, which is the true state. Both halves moved out of the
  // answered path together, so their order — the only thing that reason is
  // about — is unchanged.
  await deps.settleSecurityCheck?.({
    hold,
    outcome: HoldOutcome.Approved,
    actorSub,
  });
  // Shared with the stale detector's wait-timer sweep so the two cannot drift.
  await routeRelease(signal, deps);
}

/** The post-commit consequence of a reject: notify the delegate, then settle. */
async function rejectConsequence(
  deps: ApplyDecisionDeps,
  hold: HeldRun,
  args: { heldRunId: string; actorSub: string; reason?: string },
): Promise<void> {
  // Step-scoped rejects must notify the waiting agent so it fails the step
  // immediately rather than blocking until the hold expires.
  let securityCheckWritten = false;
  // Whether this applier handed the reject to `onWorkflowReject`. The settle
  // below then stands IN FOR that delegate, which builds its summary with no
  // actor — so it must render the same sentence rather than a richer one.
  // Otherwise one reject names its rejecter only on the path where the
  // delegate happened to throw, which is not a property of the reject.
  let delegatedToWorkflowReject = false;
  if (hold.hold_scope === HoldScope.enum.step) {
    await deps.onStepReject?.(args.heldRunId, args.reason);
  } else if (hold.hold_scope === HoldScope.enum.workflow) {
    // Workflow-scoped rejects cancel the run and drop the pending context,
    // and that handler owns the security check of the holds it reports on.
    //
    // A throwing delegate leaves `securityCheckWritten` false and falls
    // through to the settler below, which is the point: the reject has
    // already landed in the database, and the delegate is the one thing that
    // would have reported it on the commit. Letting the throw escape here
    // aborted the whole applier and stranded the hold's pending check — the
    // same reasoning, and the same handling, as the `/kici reject` handler's
    // own `.catch` around this call.
    delegatedToWorkflowReject = deps.onWorkflowReject !== undefined;
    securityCheckWritten = await Promise.resolve(deps.onWorkflowReject?.(hold, args.reason))
      .then((posted) => posted ?? false)
      .catch((err) => {
        logger.error('Failed to cancel a held run after its workflow hold was rejected', {
          heldRunId: args.heldRunId,
          runId: hold.run_id,
          error: toErrorMessage(err),
        });
        return false;
      });
  }
  // Every other hold this applier rejects — job-scoped above all — has no
  // delegate to report for it, and its row has just left `pending`, so
  // nothing downstream will ever see it again. A hold that posted no pending
  // check declines inside the settler rather than here, so this call cannot
  // fabricate one.
  if (!securityCheckWritten) {
    await deps.settleSecurityCheck?.({
      hold,
      outcome: HoldOutcome.Rejected,
      // Named only where nothing else would have named it. Threading the
      // actor through `onWorkflowReject` so BOTH paths could name it is a
      // four-signature change across modules this one does not own; until
      // that lands, matching the delegate is what makes one reject render one
      // way.
      ...(delegatedToWorkflowReject ? {} : { actorSub: args.actorSub }),
      reason: args.reason,
    });
  }
}

/** Coerce the stored requirement (jsonb or object) into an `ApprovalRequirement`. */
function normalizeRequirement(raw: unknown): ApprovalRequirement {
  if (raw && typeof raw === 'object' && 'clauses' in (raw as Record<string, unknown>)) {
    return raw as ApprovalRequirement;
  }
  // Legacy rows without a requirement: treat as "any single approval".
  return { clauses: [], expiresAt: new Date().toISOString(), reason: '' };
}
