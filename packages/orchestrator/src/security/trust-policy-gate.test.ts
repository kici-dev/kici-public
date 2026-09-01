import { describe, expect, it } from 'vitest';
import {
  ForkPolicy,
  OrchestratorMode,
  SECONDS_PER_HOUR,
  trustPolicySchema,
  type TrustPolicy,
} from '@kici-dev/engine';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import {
  DEFAULT_FORK_POLICY,
  FAIL_CLOSED_POLICY,
  READ_FAILURE_POLICY,
  evaluateTrustPolicy,
  resolveEffectivePolicy,
  type TrustPolicySignals,
} from './trust-policy-gate.js';

/** A policy whose only meaningful field is the fork switch under test. */
const policy = (forkPolicy: string): TrustPolicy => ({
  forkPolicy: forkPolicy as TrustPolicy['forkPolicy'],
  unknownContributorPolicy: 'hold',
  workflowChangePolicy: 'hold',
  approvalExpiryHours: 72,
});

/**
 * A fork PR carries tier `unknown`: `resolveRefTrust` returns it for a fork ref
 * unconditionally. `{ tier: 'trusted', isForkPR: true }` is a combination trust
 * resolution cannot produce, so the cases below use the reachable pairing.
 */
const FORK: TrustPolicySignals = { tier: 'unknown', isForkPR: true };

describe('evaluateTrustPolicy (fork switch)', () => {
  it('passes a trusted contributor whatever the fork switch says', () => {
    for (const value of ForkPolicy.options) {
      expect(evaluateTrustPolicy(policy(value), { tier: 'trusted', isForkPR: false })).toEqual({
        action: 'pass',
      });
    }
  });

  it('passes a non-fork event whatever the fork switch says', () => {
    // The switch names one condition. A non-fork event does not meet it, so it
    // has no verdict to receive here — reduced privilege for a non-trusted
    // contributor is derived from the tier further down the pipeline.
    for (const value of ForkPolicy.options) {
      for (const tier of ['known', 'unknown', undefined] as const) {
        expect(evaluateTrustPolicy(policy(value), { tier, isForkPR: false })).toEqual({
          action: 'pass',
        });
      }
    }
  });

  it('ignores a fork PR under ignore', () => {
    expect(evaluateTrustPolicy(policy(ForkPolicy.enum.ignore), FORK)).toEqual({ action: 'ignore' });
  });

  it('treats the deprecated reject as ignore', () => {
    expect(evaluateTrustPolicy(policy(ForkPolicy.enum.reject), FORK)).toEqual({ action: 'ignore' });
  });

  it('holds a fork PR under hold, with the policy window', () => {
    expect(evaluateTrustPolicy(policy(ForkPolicy.enum.hold), FORK)).toMatchObject({
      action: 'hold',
      reason: SecurityHoldReason.enum.fork_pr,
      approvalExpirySeconds: 72 * SECONDS_PER_HOUR,
    });
  });

  it('carries the approval expiry from the policy that produced the verdict', () => {
    const out = evaluateTrustPolicy(
      { ...policy(ForkPolicy.enum.hold), approvalExpiryHours: 12 },
      FORK,
    );
    expect(out).toMatchObject({ action: 'hold', approvalExpirySeconds: 12 * SECONDS_PER_HOUR });
  });

  it('converts an hours-only policy rather than falling back to the default', () => {
    // The pushed policy from an older Platform carries no seconds field at all.
    // A verdict that dropped to `DEFAULT_APPROVAL_EXPIRY_SECONDS` here would
    // silently lengthen every such org's hold to 72 hours.
    const hoursOnly: TrustPolicy = { ...policy(ForkPolicy.enum.hold), approvalExpiryHours: 3 };
    expect(hoursOnly.approvalExpirySeconds).toBeUndefined();
    expect(evaluateTrustPolicy(hoursOnly, FORK)).toMatchObject({
      approvalExpirySeconds: 3 * SECONDS_PER_HOUR,
    });
  });

  it('prefers the seconds window over the hours field beside it', () => {
    // The whole point of the field: a window an hours-granularity policy cannot
    // express must survive the verdict intact, not be rounded to its neighbour.
    const out = evaluateTrustPolicy(
      { ...policy(ForkPolicy.enum.hold), approvalExpiryHours: 72, approvalExpirySeconds: 30 },
      FORK,
    );
    expect(out).toMatchObject({ action: 'hold', approvalExpirySeconds: 30 });
  });

  it('passes a fork PR under allow', () => {
    // Degradation happens downstream off the tier, not through this outcome.
    expect(evaluateTrustPolicy(policy(ForkPolicy.enum.allow), FORK)).toEqual({ action: 'pass' });
  });

  it('holds on a verdict it does not recognise, rather than passing', () => {
    // The policy columns are plain TEXT, so a value written by a newer Platform
    // stays readable. An unrecognised verdict must not open the gate.
    const out = evaluateTrustPolicy(policy('quarantine'), FORK);
    expect(out).toMatchObject({ action: 'hold', reason: SecurityHoldReason.enum.fork_pr });
  });

  it('treats an unresolved tier on a fork PR as untrusted', () => {
    // An unanswerable trust resolution must not collapse into "fine".
    expect(
      evaluateTrustPolicy(policy(ForkPolicy.enum.hold), { tier: undefined, isForkPR: true }),
    ).toMatchObject({ action: 'hold' });
  });

  it('emits only fork_pr as a reason', () => {
    // The fork switch is the policy's only arm. `context_trust` belongs to the
    // per-context gate, which holds an individual job under its real name.
    for (const value of [...ForkPolicy.options, 'quarantine']) {
      for (const tier of ['known', 'unknown', undefined] as const) {
        for (const isForkPR of [true, false]) {
          const out = evaluateTrustPolicy(policy(value), { tier, isForkPR });
          if (out.action === 'hold' || out.action === 'reject') {
            expect(out.reason).toBe(SecurityHoldReason.enum.fork_pr);
          }
        }
      }
    }
  });

  it('never emits reject — the action set is pass | hold | ignore', () => {
    // Load-bearing for `applyTrustPolicyGate`: its `reject` arm and its
    // fail-closed `default` arm are both unreachable BECAUSE this function
    // absorbs an unrecognised fork-switch value into `hold` itself. The comment
    // on that `default` arm says exactly this, and would silently rot the day a
    // fourth action is returned from here. `'quarantine'` is the unknown value
    // — the case a newer Platform writing the plain-TEXT policy column produces.
    for (const value of [...ForkPolicy.options, 'quarantine']) {
      for (const tier of ['known', 'unknown', 'trusted', undefined] as const) {
        for (const isForkPR of [true, false]) {
          const out = evaluateTrustPolicy(policy(value), { tier, isForkPR });
          expect(['pass', 'hold', 'ignore']).toContain(out.action);
        }
      }
    }
  });

  it('produces exactly one outcome shape per action', () => {
    expect(Object.keys(evaluateTrustPolicy(policy(ForkPolicy.enum.ignore), FORK))).toEqual([
      'action',
    ]);
    expect(Object.keys(evaluateTrustPolicy(policy(ForkPolicy.enum.hold), FORK)).sort()).toEqual([
      'action',
      'approvalExpirySeconds',
      'message',
      'reason',
    ]);
  });
});

describe('resolveEffectivePolicy', () => {
  const ALLOW_ALL: TrustPolicy = policy(ForkPolicy.enum.allow);
  const stored = { ...ALLOW_ALL, source: 'platform' as const, updatedAt: new Date() };

  it('returns the stored policy whatever the mode', () => {
    for (const mode of OrchestratorMode.options) {
      expect(resolveEffectivePolicy(stored, mode)).toEqual(ALLOW_ALL);
    }
  });

  it('returns the fail-closed policy in every mode with no stored row', () => {
    // Independent mode included: no upstream authority is a reason to be
    // stricter, not more permissive.
    for (const mode of OrchestratorMode.options) {
      expect(resolveEffectivePolicy(null, mode)).toEqual(FAIL_CLOSED_POLICY);
    }
  });

  it('never returns a policy that would let a fork PR dispatch', () => {
    expect(FAIL_CLOSED_POLICY.forkPolicy).toBe(DEFAULT_FORK_POLICY);
    expect(evaluateTrustPolicy(FAIL_CLOSED_POLICY, FORK).action).not.toBe('pass');
  });
});

describe('READ_FAILURE_POLICY', () => {
  it('holds a fork PR rather than dropping it, and is not the absent-row policy', () => {
    // Both are fail-closed — neither dispatches. They differ in what they leave
    // behind, and that difference is the point: a hold is visible to the
    // contributor and approvable by an operator, where an ignored event is
    // neither. A build that pointed the read-failure path at the absent-row
    // policy would pass the first assertion and fail the second.
    expect(evaluateTrustPolicy(READ_FAILURE_POLICY, FORK).action).toBe('hold');
    expect(READ_FAILURE_POLICY.forkPolicy).not.toBe(FAIL_CLOSED_POLICY.forkPolicy);
  });

  it('holds only forks — the evaluator guards still run ahead of it', () => {
    expect(evaluateTrustPolicy(READ_FAILURE_POLICY, { tier: 'unknown', isForkPR: false })).toEqual({
      action: 'pass',
    });
    expect(evaluateTrustPolicy(READ_FAILURE_POLICY, { tier: 'trusted', isForkPR: true })).toEqual({
      action: 'pass',
    });
  });

  it('carries every key of the wire policy schema', () => {
    expect(Object.keys(READ_FAILURE_POLICY).sort()).toEqual(
      Object.keys(trustPolicySchema.shape).sort(),
    );
  });
});

describe('policy key coverage', () => {
  it('carries every key of the wire policy schema', () => {
    // The two deprecated keys are still on the wire, so the resolved policy has
    // to carry them even though no decision reads them.
    expect(Object.keys(FAIL_CLOSED_POLICY).sort()).toEqual(
      Object.keys(trustPolicySchema.shape).sort(),
    );
  });

  it('changes its verdict when the fork switch changes', () => {
    expect(evaluateTrustPolicy(policy(ForkPolicy.enum.hold), FORK).action).toBe('hold');
    expect(evaluateTrustPolicy(policy(ForkPolicy.enum.ignore), FORK).action).toBe('ignore');
    expect(evaluateTrustPolicy(policy(ForkPolicy.enum.allow), FORK).action).toBe('pass');
    // `approvalExpiryHours` is consumed by the hold path, asserted above and in
    // dispatch-matched-workflow.test.ts.
  });

  it('does not read either deprecated key', () => {
    // The claim the wire schema's `@deprecated` JSDoc makes: these are accepted
    // and stored, and no decision reads them. Changing both leaves the verdict
    // identical for every fork-switch value.
    for (const value of ForkPolicy.options) {
      const base = policy(value);
      const flipped: TrustPolicy = {
        ...base,
        unknownContributorPolicy: 'reject',
        workflowChangePolicy: 'allow',
      };
      expect(evaluateTrustPolicy(flipped, FORK)).toEqual(evaluateTrustPolicy(base, FORK));
    }
  });
});
