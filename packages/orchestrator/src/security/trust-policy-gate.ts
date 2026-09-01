/**
 * Org trust-policy gate — turns the org's fork switch plus the per-PR signals
 * into exactly one outcome.
 *
 * Pure: no I/O, no DB, no clock. The caller supplies the effective policy (see
 * `resolveEffectivePolicy`) and the signals; enforcement lives elsewhere — the
 * webhook pipeline drops an `ignore`d event before it can create a run, and the
 * dispatch gate acts on the remaining verdicts.
 *
 * Scope: the pipeline reaches this through `evaluateSecurityPolicy`, which
 * short-circuits to `pass` for a source whose provider bundle leaves
 * `hasForkModel` unset — so a source with no fork model never reaches the
 * switch below by that route. That short-circuit is not a trust claim: a
 * PR from a fork-less provider resolves NO tier, because the fork signal such a
 * provider computes reads `false` whenever the payload keys it compares are
 * absent. Those sources skip the switch because its one condition — "the PR
 * came from a fork" — cannot be established for them, not because they are
 * trusted.
 */
import { z } from 'zod';
import {
  DEFAULT_APPROVAL_EXPIRY_HOURS,
  DEFAULT_APPROVAL_EXPIRY_SECONDS,
  ForkPolicy,
  approvalExpirySecondsOf,
} from '@kici-dev/engine';
import type { OrchestratorMode, TrustPolicy, TrustTier } from '@kici-dev/engine';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import type { StoredTrustPolicy } from './trust-policy-store.js';

/**
 * The enforcement vocabulary the admin API reports and `kici-admin
 * trust-policy show` renders.
 *
 * @deprecated The route reports `policy` unconditionally: `resolveEffectivePolicy`
 * returns a policy for every input, so there is no state left in which the
 * values are absent. The field and this enum stay so an older `kici-admin`
 * binary keeps parsing the response. Removed at v1.0.0.
 */
export const TrustPolicyEnforcement = z.enum(['policy', 'legacy']);
export type TrustPolicyEnforcement = z.infer<typeof TrustPolicyEnforcement>;

/** The per-PR facts the fork switch is evaluated against. */
export interface TrustPolicySignals {
  /** Resolved contributor tier; undefined when no tier was resolved. */
  tier: TrustTier | undefined;
  /** The PR's head repo differs from its base repo. */
  isForkPR: boolean;
}

/**
 * The reason the ORG TRUST POLICY itself raises.
 *
 * The fork switch is the policy's only arm, so `fork_pr` is the only reason it
 * can produce. The `SecurityHoldReason` Zod enum deliberately keeps its other
 * members: `held_runs` rows written by earlier builds still carry them, and the
 * per-context minimum-trust gate still writes `context_trust` under its own
 * name. Narrowing here is a statement about what this gate emits, not about
 * what the column may hold.
 */
export type TrustPolicyHoldReason = Extract<SecurityHoldReason, 'fork_pr'>;

export type TrustPolicyOutcome =
  | { action: 'pass' }
  /**
   * Drop the event entirely: no run row, no check status, nothing dispatched.
   * The pipeline enforces this before it fetches a lock file, so an ignored
   * event leaves no trace a contributor can see.
   */
  | { action: 'ignore' }
  | {
      action: 'hold';
      reason: TrustPolicyHoldReason;
      message: string;
      /**
       * Seconds the resulting hold stays approvable, taken from the SAME policy
       * that produced this verdict.
       *
       * Carried on the outcome rather than re-read at the hold site: a second,
       * independent read bypassed `resolveEffectivePolicy`, so it was both a
       * TOCTOU (the policy could change between deciding and sizing) and a
       * divergence between deciding and sizing. `null` means "no window came
       * with this verdict", and the hold site falls back to
       * `DEFAULT_APPROVAL_EXPIRY_SECONDS`.
       *
       * Seconds, not hours, because this is what the hold site actually needs:
       * an hours-only window cannot express the sub-hour hold the policy may now
       * carry, and rounding it here would silently lengthen it.
       */
      approvalExpirySeconds: number | null;
    }
  | { action: 'reject'; reason: TrustPolicyHoldReason; message: string };

/**
 * The reason a verdict carries, or `undefined` for one that carries none.
 *
 * Logging and check-status call sites take any outcome, so they need the reason
 * without narrowing the union themselves — and a call site that reached for
 * `.reason` on a reasonless verdict would print `undefined` rather than fail.
 */
export function trustPolicyOutcomeReason(
  outcome: TrustPolicyOutcome,
): TrustPolicyHoldReason | undefined {
  return outcome.action === 'hold' || outcome.action === 'reject' ? outcome.reason : undefined;
}

/** The fork switch applied when no policy row is stored. */
export const DEFAULT_FORK_POLICY: ForkPolicy = ForkPolicy.enum.ignore;

/**
 * The policy applied when no row is stored — in every mode. Ignoring fork
 * events is the fail-closed posture: nothing foreign dispatches, and the event
 * is dropped rather than parked in a queue nobody is watching.
 *
 * This is NOT necessarily a brief transient. The Platform sends
 * `trust_policy.update` only when the org has a `trust_policies` row, and that
 * row is created lazily on a dashboard read — so an org that has never opened
 * Settings > CI trust receives no push at all and stays on these values
 * indefinitely.
 */
export const FAIL_CLOSED_POLICY: TrustPolicy = Object.freeze({
  forkPolicy: DEFAULT_FORK_POLICY,
  // Inert: the gate reads neither field. They are carried because the wire
  // schema still declares them.
  unknownContributorPolicy: 'hold',
  workflowChangePolicy: 'hold',
  approvalExpiryHours: DEFAULT_APPROVAL_EXPIRY_HOURS,
  approvalExpirySeconds: DEFAULT_APPROVAL_EXPIRY_SECONDS,
});

/**
 * The policy applied when the stored row could not be READ — a thrown query, a
 * dropped connection.
 *
 * Distinct from `FAIL_CLOSED_POLICY`, which answers a different question: that
 * one is what an org with no stored row has chosen by not choosing. A read
 * failure says nothing about what the org chose, and an org that chose `hold`
 * or `allow` would have its fork PRs dropped with no trace if the two cases
 * shared an answer — a transient database blip turning a recoverable,
 * contributor-visible hold into a silent disappearance.
 *
 * Holding is fail-closed on the same terms: nothing untrusted dispatches. It is
 * also recoverable — the contributor sees the security check, and an operator
 * can approve it — which an ignored event is not.
 */
export const READ_FAILURE_POLICY: TrustPolicy = Object.freeze({
  forkPolicy: ForkPolicy.enum.hold,
  // Inert, exactly as in `FAIL_CLOSED_POLICY`: the gate reads neither field.
  unknownContributorPolicy: 'hold',
  workflowChangePolicy: 'hold',
  approvalExpiryHours: DEFAULT_APPROVAL_EXPIRY_HOURS,
  approvalExpirySeconds: DEFAULT_APPROVAL_EXPIRY_SECONDS,
});

/**
 * Pick the policy to evaluate. A stored row always wins; without one every
 * orchestrator gets the fail-closed policy above.
 *
 * `mode` no longer selects between two postures — an independent orchestrator
 * has no upstream authority, which is a reason to be stricter rather than more
 * permissive — but it stays on the signature so callers that legitimately hold
 * a mode do not have to change, and so a future per-mode difference has a place
 * to land.
 */
export function resolveEffectivePolicy(
  stored: StoredTrustPolicy | null,
  _mode: OrchestratorMode,
): TrustPolicy {
  if (stored) {
    return {
      forkPolicy: stored.forkPolicy,
      unknownContributorPolicy: stored.unknownContributorPolicy,
      workflowChangePolicy: stored.workflowChangePolicy,
      approvalExpiryHours: stored.approvalExpiryHours,
      approvalExpirySeconds: stored.approvalExpirySeconds,
    };
  }
  return FAIL_CLOSED_POLICY;
}

/** The message carried by every verdict the fork switch raises. */
const FORK_PR_MESSAGE = 'Pull request originates from a fork';

function holdForFork(policy: TrustPolicy): TrustPolicyOutcome {
  return {
    action: 'hold',
    reason: SecurityHoldReason.enum.fork_pr,
    message: FORK_PR_MESSAGE,
    // Resolved through the shared rule rather than read off one field, so a
    // policy that carries only the coarse hours spelling still sizes the hold.
    approvalExpirySeconds: approvalExpirySecondsOf(policy),
  };
}

/**
 * Evaluate the fork switch.
 *
 * Two guards precede it. A `trusted` tier passes: the ref lives in the base
 * repo, so only a write-or-higher contributor could have put it there. A
 * non-fork event passes too — the switch names one condition, and an event that
 * does not meet it has no verdict to receive here. Reduced privilege for a
 * non-trusted contributor is derived from the tier further down the pipeline,
 * not from this outcome.
 */
export function evaluateTrustPolicy(
  policy: TrustPolicy,
  signals: TrustPolicySignals,
): TrustPolicyOutcome {
  if (signals.tier === 'trusted') return { action: 'pass' };
  if (!signals.isForkPR) return { action: 'pass' };

  switch (policy.forkPolicy) {
    case ForkPolicy.enum.allow:
      return { action: 'pass' };
    case ForkPolicy.enum.hold:
      return holdForFork(policy);
    // `reject` is deprecated in favour of `ignore` and behaves as it, so an
    // orchestrator on this build honours a stored `reject` row without
    // requiring the operator to rewrite it first.
    case ForkPolicy.enum.ignore:
    case ForkPolicy.enum.reject:
      return { action: 'ignore' };
    default:
      // The policy columns are plain TEXT so a value written by a newer
      // Platform stays readable — which means an unrecognised verdict is
      // reachable, and for a security control the safe reading of "I do not
      // understand this" is `hold`, not `pass`.
      return holdForFork(policy);
  }
}
