/**
 * Pure approval-clause evaluator. No DB access, no I/O — given a requirement,
 * a team-membership lookup, the recorded decisions, and (for eligibility) the
 * run's triggerer + the self-approval policy, it answers:
 *
 * - `evaluate` — is the requirement satisfied (all clauses ANDed), and was it
 *   rejected (any single reject decision)?
 * - `canApprove` — may a given actor cast an approve decision right now?
 *
 * Both the dashboard handler and the CLI HTTP route funnel through these so the
 * authorization story is identical regardless of the surface.
 */
import type { ApprovalRequirement, ApproverClause } from '@kici-dev/engine';

/** A team name → set of member user ids (Keycloak subs). */
export type TeamMembershipLookup = (team: string) => Set<string>;

/** One recorded decision row (subset of `held_run_approvals`). */
export interface RecordedDecision {
  approver_user_id: string;
  decision: 'approve' | 'reject';
}

/** Per-clause satisfaction detail for attribution + dashboard progress. */
export interface PerClauseResult {
  clause: ApproverClause;
  satisfied: boolean;
  /** The approver who satisfied this clause, if any. */
  by?: string;
}

export interface EvaluationResult {
  /** All clauses satisfied (AND). For empty clauses: any single approve. */
  satisfied: boolean;
  /** Any reject decision present → the element is rejected. */
  rejected: boolean;
  perClause: PerClauseResult[];
}

/**
 * Is a single clause satisfied by any approve decision whose approver is
 * eligible for the clause? Reject decisions never satisfy.
 */
export function isClauseSatisfied(
  clause: ApproverClause,
  decisions: RecordedDecision[],
  lookup: TeamMembershipLookup,
): boolean {
  return decisions.some(
    (d) => d.decision === 'approve' && isActorEligibleForClause(d.approver_user_id, clause, lookup),
  );
}

/** Does an actor satisfy/qualify for a clause (team membership or exact user)? */
export function isActorEligibleForClause(
  actorSub: string,
  clause: ApproverClause,
  lookup: TeamMembershipLookup,
): boolean {
  if ('team' in clause) return lookup(clause.team).has(actorSub);
  return clause.user === actorSub;
}

/** The approver who first satisfied a clause, if any. */
function clauseSatisfiedBy(
  clause: ApproverClause,
  decisions: RecordedDecision[],
  lookup: TeamMembershipLookup,
): string | undefined {
  const hit = decisions.find(
    (d) => d.decision === 'approve' && isActorEligibleForClause(d.approver_user_id, clause, lookup),
  );
  return hit?.approver_user_id;
}

/**
 * Evaluate a requirement against the recorded decisions.
 *
 * - A single reject decision sets `rejected` (the caller fails the element).
 * - Empty clauses ⇒ satisfied by ANY single approve decision.
 * - Non-empty clauses ⇒ satisfied iff every clause is satisfied (AND).
 */
export function evaluate(
  requirement: ApprovalRequirement,
  decisions: RecordedDecision[],
  lookup: TeamMembershipLookup,
): EvaluationResult {
  const rejected = decisions.some((d) => d.decision === 'reject');

  if (requirement.clauses.length === 0) {
    const satisfied = !rejected && decisions.some((d) => d.decision === 'approve');
    return { satisfied, rejected, perClause: [] };
  }

  const perClause: PerClauseResult[] = requirement.clauses.map((clause) => {
    const by = clauseSatisfiedBy(clause, decisions, lookup);
    return { clause, satisfied: by !== undefined, by };
  });
  const satisfied = !rejected && perClause.every((c) => c.satisfied);
  return { satisfied, rejected, perClause };
}

export interface CanApproveContext {
  /** The Keycloak sub of the user who triggered the run. */
  triggererSub: string;
  /** Whether the triggerer may self-approve their own held elements. */
  allowSelfApproval: boolean;
}

/**
 * May `actorSub` cast an approve decision on this requirement right now?
 *
 * - Self-approval gate: when `allowSelfApproval` is false and the actor is the
 *   run's triggerer, they may never approve.
 * - Eligibility: the actor must qualify for at least one still-UNSATISFIED
 *   clause. (Approving a clause that is already satisfied adds nothing.) For an
 *   empty-clause requirement, any non-triggerer-blocked actor qualifies.
 */
export function canApprove(
  actorSub: string,
  requirement: ApprovalRequirement,
  decisions: RecordedDecision[],
  lookup: TeamMembershipLookup,
  ctx: CanApproveContext,
): boolean {
  if (!ctx.allowSelfApproval && actorSub === ctx.triggererSub) return false;

  if (requirement.clauses.length === 0) return true;

  const { perClause } = evaluate(requirement, decisions, lookup);
  // Eligible for at least one clause that is not yet satisfied.
  return perClause.some(
    (c) => !c.satisfied && isActorEligibleForClause(actorSub, c.clause, lookup),
  );
}
