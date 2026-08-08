/**
 * Org trust-policy gate — turns the Platform-owned policy plus three per-PR
 * signals into exactly one outcome.
 *
 * Pure: no I/O, no DB, no clock. The caller supplies the effective policy (see
 * `resolveEffectivePolicy`) and the signals; enforcement lives in the dispatch
 * gate.
 *
 * Scope: the caller only invokes this for sources whose provider bundle carries
 * a `ContributorResolver` (GitHub today). Every other source is trusted by
 * construction and never reaches here.
 */
import { z } from 'zod';
import { DEFAULT_APPROVAL_EXPIRY_HOURS, PLATFORM_CONNECTED_MODES } from '@kici-dev/engine';
import type { OrchestratorMode, TrustPolicy, TrustTier } from '@kici-dev/engine';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import type { StoredTrustPolicy } from './trust-policy-store.js';

/**
 * Which arm of the gate is actually in force for an org — the vocabulary the
 * admin API reports and `kici-admin trust-policy show` renders.
 *
 * `policy` means `resolveEffectivePolicy` produced a policy and all three arms
 * apply; `legacy` means it produced `null`, so only the legacy
 * workflow-modification rule runs and there are no policy values to report.
 * Named here, next to the resolver that decides between them, so the route and
 * the CLI cannot drift apart on a bare string literal.
 */
export const TrustPolicyEnforcement = z.enum(['policy', 'legacy']);
export type TrustPolicyEnforcement = z.infer<typeof TrustPolicyEnforcement>;

/** The per-PR facts the policy is evaluated against. */
export interface TrustPolicySignals {
  /** Resolved contributor tier; undefined when trust resolution failed. */
  tier: TrustTier | undefined;
  /** The PR's head repo differs from its base repo. */
  isForkPR: boolean;
  /** The PR changes `.kici/` workflow definitions. */
  hasWorkflowModifications: boolean;
}

/**
 * The reasons the ORG TRUST POLICY itself can raise — its three arms.
 *
 * `context_trust` is excluded at the type level rather than merely by
 * convention: that reason belongs to the per-context minimum-trust gate, which
 * holds an individual job under its real name. Narrowing here is what lets
 * `SECURITY_HOLD_JOB_IDS` drop its phantom `context_trust` sentinel — a value
 * that existed only to satisfy a `Record<SecurityHoldReason, ...>` and was never
 * written to a single row.
 */
export type TrustPolicyHoldReason = Exclude<SecurityHoldReason, 'context_trust'>;

export type TrustPolicyOutcome =
  | { action: 'pass' }
  | {
      action: 'hold';
      reason: TrustPolicyHoldReason;
      message: string;
      /**
       * Hours the resulting hold stays approvable, taken from the SAME policy
       * that produced this verdict. `null` in independent mode, where there is
       * no upstream policy and therefore no operator-set window.
       *
       * Carried on the outcome rather than re-read at the hold site: a second,
       * independent read bypassed `resolveEffectivePolicy`, so it was both a
       * TOCTOU (the policy could change between deciding and sizing) and a
       * divergence — independent mode got the 72h default where the decision
       * path deliberately has no policy at all.
       */
      approvalExpiryHours: number | null;
    }
  | { action: 'reject'; reason: TrustPolicyHoldReason; message: string };

/**
 * The policy a Platform-attached orchestrator applies when it has no stored
 * row. Every arm holds — a hold is recoverable by approval, and these are the
 * documented org defaults, so an org that never changed its policy gets the
 * behavior its dashboard shows.
 *
 * This is NOT necessarily a brief transient. The Platform sends
 * `trust_policy.update` only when the org has a `trust_policies` row, and that
 * row is created lazily on a dashboard read — so an org that has never opened
 * Settings > CI trust receives no push at all and stays on these values
 * indefinitely. The expiry is therefore the generous documented default rather
 * than a short one: a short window would auto-fail legitimate runs.
 */
export const FAIL_CLOSED_POLICY: TrustPolicy = Object.freeze({
  forkPolicy: 'hold',
  unknownContributorPolicy: 'hold',
  workflowChangePolicy: 'hold',
  approvalExpiryHours: DEFAULT_APPROVAL_EXPIRY_HOURS,
});

/**
 * Pick the policy to evaluate. A stored row always wins. Without one, a
 * Platform-attached orchestrator fails closed (a push is imminent); an
 * independent orchestrator has no upstream authority at all, so it gets `null`
 * and the evaluator applies only the legacy rule — which is what keeps this
 * change from silently gating existing independent deployments on upgrade.
 *
 * `PLATFORM_CONNECTED_MODES` is the shared definition of "expects a Platform
 * push", so a mode added there is fail-closed here without a second edit.
 */
export function resolveEffectivePolicy(
  stored: StoredTrustPolicy | null,
  mode: OrchestratorMode,
): TrustPolicy | null {
  if (stored) {
    return {
      forkPolicy: stored.forkPolicy,
      unknownContributorPolicy: stored.unknownContributorPolicy,
      workflowChangePolicy: stored.workflowChangePolicy,
      approvalExpiryHours: stored.approvalExpiryHours,
    };
  }
  return PLATFORM_CONNECTED_MODES.includes(mode) ? FAIL_CLOSED_POLICY : null;
}

/** A contributor the policy arms apply to: anyone below `trusted`. */
function isNonTrusted(tier: TrustTier | undefined): boolean {
  return tier !== 'trusted';
}

const MESSAGES: Record<TrustPolicyHoldReason, string> = {
  workflow_modification: 'Workflow files were modified by a non-trusted contributor',
  fork_pr: 'Pull request originates from a fork',
  unknown_contributor: 'Contributor could not be resolved to a known identity',
};

/**
 * Evaluate the policy.
 *
 * Arms are evaluated in a fixed order — workflow_modification, fork_pr,
 * unknown_contributor — and then any `reject` beats any `hold`, with the first
 * arm in that order supplying the reason among equals. That makes a PR tripping
 * several arms produce one outcome with a stable reason rather than a verdict
 * that depends on evaluation accident.
 *
 * An unresolved tier (`undefined`) counts as `unknown`, never as a pass: a
 * trust resolution that could not be answered is not evidence of trust.
 *
 * A `null` policy applies only the legacy rule (workflow modifications by a
 * non-trusted contributor hold), reproducing behavior from before the policy was
 * enforced.
 */
export function evaluateTrustPolicy(
  policy: TrustPolicy | null,
  signals: TrustPolicySignals,
): TrustPolicyOutcome {
  if (!isNonTrusted(signals.tier)) return { action: 'pass' };

  if (policy === null) {
    return signals.hasWorkflowModifications
      ? {
          action: 'hold',
          reason: SecurityHoldReason.enum.workflow_modification,
          message: MESSAGES.workflow_modification,
          // Independent mode: no upstream policy, so no operator-set window.
          approvalExpiryHours: null,
        }
      : { action: 'pass' };
  }

  // A fork PR ALWAYS resolves to tier `unknown` (trust-resolver.ts returns it
  // unconditionally for a fork), so the unknown-contributor arm would otherwise
  // fire for every fork — and since `unknownContributorPolicy` has no `allow`
  // member, no configuration could ever let a fork PR run. That made
  // `forkPolicy: 'allow'` unreachable while the docs told open-source operators
  // to use it: a second inert setting inside the fix for the first one.
  //
  // When the fork is what caused the unknown tier and the operator has
  // explicitly allowed forks, the fork arm wins. Deliberately narrow: a
  // NON-fork unknown contributor is unaffected, because widening
  // `unknownContributorPolicy` would let any unresolvable contributor run.
  const forkAllowsThisEvent = signals.isForkPR && policy.forkPolicy === 'allow';

  const arms: Array<{ reason: TrustPolicyHoldReason; applies: boolean; verdict: string }> = [
    {
      reason: SecurityHoldReason.enum.workflow_modification,
      applies: signals.hasWorkflowModifications,
      verdict: policy.workflowChangePolicy,
    },
    {
      reason: SecurityHoldReason.enum.fork_pr,
      applies: signals.isForkPR,
      verdict: policy.forkPolicy,
    },
    {
      reason: SecurityHoldReason.enum.unknown_contributor,
      applies: (signals.tier === 'unknown' || signals.tier === undefined) && !forkAllowsThisEvent,
      verdict: policy.unknownContributorPolicy,
    },
  ];

  const applicable = arms.filter((arm) => arm.applies);
  const rejecting = applicable.find((arm) => arm.verdict === 'reject');
  if (rejecting) {
    return { action: 'reject', reason: rejecting.reason, message: MESSAGES[rejecting.reason] };
  }
  // Anything that is not an explicit `allow` holds. The policy columns are
  // plain TEXT so a value written by a newer Platform stays readable — which
  // means an unrecognised verdict is reachable, and for a security control the
  // safe reading of "I do not understand this" is `hold`, not `pass`.
  const holding = applicable.find((arm) => arm.verdict !== 'allow');
  if (holding) {
    return {
      action: 'hold',
      reason: holding.reason,
      message: MESSAGES[holding.reason],
      approvalExpiryHours: policy.approvalExpiryHours,
    };
  }
  return { action: 'pass' };
}
