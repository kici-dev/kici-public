/**
 * Shared approve/reject applier — the single path behind the dashboard WS
 * handler and the `kici` CLI HTTP route, so authorization and resume are
 * identical on both surfaces.
 *
 * An approve runs `canApprove` (eligibility + self-approval gate), records the
 * decision in `held_run_approvals`, and when every clause is satisfied releases
 * the hold and resumes the element (re-dispatch for job/workflow; the caller's
 * `onStepRelease` agent bridge for step scope). A reject records the decision
 * and rejects the hold, failing the element.
 *
 * **A decision answers at its durable record, not at its consequence.** The
 * transaction that flips the hold row (`recordAndRelease` / `recordAndReject`)
 * is the commit AND serialization point: both are `WHERE status = 'pending'`,
 * so a second decider loses there. The consequence's cost is unbounded
 * (a workflow release replays the whole stored dispatch context; a reject
 * completes a provider check run per queued job), so it comes back as
 * `ApplyDecisionResult.consequence` — started, never awaited, never rejecting.
 */
import { createLogger, toErrorMessage } from '@kici-dev/shared';
import {
  AccessLogAction,
  ApprovalDecision,
  HoldScope,
  type ApprovalRequirement,
} from '@kici-dev/engine';

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

/**
 * The access-log action a held-run decision is audited under. A
 * `kici run --approve-all` breakglass approval audits as `held_run.auto_approve`
 * to set it apart from an interactive approve; eligibility is enforced the same
 * for both, and a reject never gets it. Every approving surface takes its action
 * from here, so Platform-relayed and admin-route approvals audit one act one way.
 */
export function heldRunDecisionAction(
  decision: ApprovalDecision,
  autoApprove: boolean,
): AccessLogAction {
  if (decision === ApprovalDecision.enum.reject) return AccessLogAction.enum['held_run.reject'];
  return autoApprove
    ? AccessLogAction.enum['held_run.auto_approve']
    : AccessLogAction.enum['held_run.approve'];
}

/** Whether a decision's post-commit consequence ran to completion. */
export interface DecisionConsequenceResult {
  /** False when a step of the consequence chain threw. */
  ok: boolean;
  error?: string;
}

/** Outcome of applying a decision. */
export interface ApplyDecisionResult {
  /** Whether the decision was recorded. */
  accepted: boolean;
  status: 'released' | 'rejected' | 'pending' | 'ineligible' | 'not-found';
  /** When still pending, how many clauses remain unsatisfied. */
  remainingClauses?: number;
  /** When ineligible/not-found, a reason for the caller to surface. */
  reason?: string;
  /** The release signal, when the element was released (for the caller to resume). */
  release?: ReleaseSignal;
  /**
   * The post-commit consequence — already running, deliberately not awaited.
   * Present on `released` and `rejected`; absent when nothing changed.
   *
   * It NEVER rejects: a throw is logged and surfaces as `{ ok: false, error }`,
   * so a caller may leave it unawaited. A caller answering a waiting client
   * answers first and attaches its audit record to this, so the record carries
   * the real outcome rather than a guess. A test or sequential sweep awaits it.
   *
   * Awaiting it made an approve spend nine-plus seconds behind a ten-second
   * relay budget and answer 504 on an approval that had landed. Awaiting adds no
   * strength: the resume is the same dispatch the original webhook ran with no
   * client waiting, `dispatchMatchedWorkflow` returning means only that jobs
   * were routed, and `resumeWorkflow` reports its own failures on the run row
   * and the provider's check runs.
   */
  consequence?: Promise<DecisionConsequenceResult>;
}

/** Dependencies injected into `applyDecision` (testable in isolation). */
export interface ApplyDecisionDeps {
  orgId: string;
  store: HeldRunStore;
  /** Team name → member user ids (from the trust-policy cache). */
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
   * the pending workflow context. The rejecter's reason becomes the run's
   * cancellation reason: this serves the install gate, the trust policy's
   * PR-wide hold and the SDK's workflow `requireApproval` alike, so a reason
   * invented at the wiring site would misattribute one of them.
   *
   * The row tells those apart: only some posted a pending `KiCI Security` check.
   * Resolves to whether a terminal security check was WRITTEN, so this applier
   * suppresses its own post only when one landed.
   */
  onWorkflowReject?: (hold: HeldRun, reason?: string) => Promise<boolean>;
  /**
   * Terminalize the `KiCI Security` check of every hold this applier ends that
   * `onWorkflowReject` did not already report. Without it a job-scoped hold
   * answered from the dashboard strands its check: the row leaves `pending`, so
   * the stale detector's pending-only approval-window sweep never reaches it.
   * Optional so an orchestrator with no provider wiring degrades to
   * flip-and-resume rather than failing the decision.
   *
   * `actorSub` is an opaque subject id a contributor cannot read; the wiring
   * site resolves it to a display name (or drops it), since only it holds the
   * org's identity directory. Omitted where the summary must match one a
   * delegate built without it; see the reject arm below.
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
    // One transaction, so a crash cannot leave an orphaned reject decision
    // that poisons evaluate() while the hold stays pending.
    await store.recordAndReject(
      orgId,
      args.heldRunId,
      { approverSub: args.actorSub, decision: ApprovalDecision.enum.reject },
      args.reason,
    );
    // Durable here; see `ApplyDecisionResult.consequence`.
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

  // Persisted so the dashboard renders per-clause attribution without the
  // team-membership lookup.
  const clausesSatisfied = requirement.clauses.filter((clause) =>
    isActorEligibleForClause(args.actorSub, clause, teamMembershipLookup),
  );

  // Only the *satisfying* approve needs record + release to be atomic; a
  // recorded approve with the hold still pending is a valid steady state.
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

  // One transaction, so a crash cannot leave the hold pending-but-satisfied
  // (canApprove() then returns false for everyone). The commit point.
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
 * Run a post-commit consequence, converting any throw into a logged
 * `{ ok: false }`. Must never reject: callers may leave it unawaited, and an
 * unawaited rejection takes the orchestrator process down.
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
  // BEFORE the resume: a replayed dispatch can hold again and post its own
  // pending `KiCI Security` status, which settling afterwards would overwrite
  // with `success` — a green check over held work. This way the replay's
  // pending post lands last and wins.
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
  // A step reject notifies the waiting agent so it fails the step now rather
  // than blocking until the hold expires.
  let securityCheckWritten = false;
  // When the reject went to `onWorkflowReject`, the settle below stands IN FOR
  // that delegate, which builds its summary with no actor — so it renders the
  // same sentence, or the rejecter would be named only when the delegate threw.
  let delegatedToWorkflowReject = false;
  if (hold.hold_scope === HoldScope.enum.step) {
    await deps.onStepReject?.(args.heldRunId, args.reason);
  } else if (hold.hold_scope === HoldScope.enum.workflow) {
    // That handler owns the security check of the holds it reports on. A
    // throwing delegate falls through to the settler below: the reject has
    // landed, and an escaping throw would abort the applier and strand the
    // pending check — the same handling as the `/kici reject` handler's own
    // `.catch` around this call.
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
  // Any other rejected hold (job-scoped above all) has no delegate, and its row
  // just left `pending`, so nothing downstream sees it again. A hold that
  // posted no pending check declines inside the settler, so this cannot
  // fabricate one.
  if (!securityCheckWritten) {
    await deps.settleSecurityCheck?.({
      hold,
      outcome: HoldOutcome.Rejected,
      // Named only where nothing else names it. Threading the actor through
      // `onWorkflowReject` is a four-signature change across modules this one
      // does not own; matching the delegate keeps one reject rendering one way.
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
