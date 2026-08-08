import { describe, expect, it } from 'vitest';
import { OrchestratorMode, trustPolicySchema, type TrustPolicy } from '@kici-dev/engine';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import {
  FAIL_CLOSED_POLICY,
  evaluateTrustPolicy,
  resolveEffectivePolicy,
  type TrustPolicySignals,
} from './trust-policy-gate.js';

const ALLOW_ALL: TrustPolicy = {
  forkPolicy: 'allow',
  unknownContributorPolicy: 'hold', // no 'allow' member exists in the wire enum
  workflowChangePolicy: 'allow',
  approvalExpiryHours: 72,
};

const SIGNALS: TrustPolicySignals = {
  tier: 'known',
  isForkPR: false,
  hasWorkflowModifications: false,
};

describe('evaluateTrustPolicy', () => {
  it('passes a trusted contributor regardless of policy', () => {
    expect(
      evaluateTrustPolicy(FAIL_CLOSED_POLICY, {
        tier: 'trusted',
        isForkPR: true,
        hasWorkflowModifications: true,
      }),
    ).toEqual({ action: 'pass' });
  });

  it('holds a known contributor who modified workflows', () => {
    const out = evaluateTrustPolicy(
      { ...ALLOW_ALL, workflowChangePolicy: 'hold' },
      { ...SIGNALS, hasWorkflowModifications: true },
    );
    expect(out).toMatchObject({
      action: 'hold',
      reason: SecurityHoldReason.enum.workflow_modification,
    });
  });

  it('allows a workflow modification when the policy says allow', () => {
    expect(evaluateTrustPolicy(ALLOW_ALL, { ...SIGNALS, hasWorkflowModifications: true })).toEqual({
      action: 'pass',
    });
  });

  it('rejects a workflow modification when the policy says reject', () => {
    const out = evaluateTrustPolicy(
      { ...ALLOW_ALL, workflowChangePolicy: 'reject' },
      { ...SIGNALS, hasWorkflowModifications: true },
    );
    expect(out).toMatchObject({
      action: 'reject',
      reason: SecurityHoldReason.enum.workflow_modification,
    });
  });

  it('holds a fork PR when the fork policy says hold', () => {
    const out = evaluateTrustPolicy(
      { ...ALLOW_ALL, forkPolicy: 'hold' },
      { ...SIGNALS, isForkPR: true },
    );
    expect(out).toMatchObject({ action: 'hold', reason: SecurityHoldReason.enum.fork_pr });
  });

  it('rejects a fork PR when the fork policy says reject', () => {
    const out = evaluateTrustPolicy(
      { ...ALLOW_ALL, forkPolicy: 'reject' },
      { ...SIGNALS, isForkPR: true },
    );
    expect(out).toMatchObject({ action: 'reject', reason: SecurityHoldReason.enum.fork_pr });
  });

  // The cases below all use `tier: 'unknown'` with `isForkPR: true`, which is
  // the ONLY tier a fork PR can carry in production — `trust-resolver.ts`
  // returns `unknown` unconditionally for a fork. The case these replaced
  // passed `{ tier: 'known', isForkPR: true }`, a combination TrustResolver
  // cannot produce, and being green about an unreachable configuration is
  // exactly how this defect survived nine reviews.
  it('allows a fork PR when forkPolicy is allow, even though the fork forces tier unknown', () => {
    expect(evaluateTrustPolicy(ALLOW_ALL, { ...SIGNALS, tier: 'unknown', isForkPR: true })).toEqual(
      { action: 'pass' },
    );
  });

  it('still holds a NON-fork unknown contributor when forkPolicy is allow', () => {
    // The load-bearing case: it pins that the suppression is narrow, and that
    // `forkPolicy: 'allow'` did not silently become a general
    // unknown-contributor bypass.
    const out = evaluateTrustPolicy(ALLOW_ALL, {
      ...SIGNALS,
      tier: 'unknown',
      isForkPR: false,
    });
    expect(out).toMatchObject({
      action: 'hold',
      reason: SecurityHoldReason.enum.unknown_contributor,
    });
  });

  it('still holds a fork PR when forkPolicy is hold', () => {
    const out = evaluateTrustPolicy(
      { ...ALLOW_ALL, forkPolicy: 'hold' },
      { ...SIGNALS, tier: 'unknown', isForkPR: true },
    );
    expect(out).toMatchObject({ action: 'hold', reason: SecurityHoldReason.enum.fork_pr });
  });

  it('still rejects a fork PR when forkPolicy is reject', () => {
    const out = evaluateTrustPolicy(
      { ...ALLOW_ALL, forkPolicy: 'reject' },
      { ...SIGNALS, tier: 'unknown', isForkPR: true },
    );
    expect(out).toMatchObject({ action: 'reject', reason: SecurityHoldReason.enum.fork_pr });
  });

  it('workflowChangePolicy still governs an allowed fork that modifies workflows', () => {
    // Precedence: allowing forks must not exempt a fork PR from the workflow
    // change arm, which is the arm that guards `.kici/` itself.
    const out = evaluateTrustPolicy(
      { ...ALLOW_ALL, forkPolicy: 'allow', workflowChangePolicy: 'reject' },
      { ...SIGNALS, tier: 'unknown', isForkPR: true, hasWorkflowModifications: true },
    );
    expect(out).toMatchObject({
      action: 'reject',
      reason: SecurityHoldReason.enum.workflow_modification,
    });
  });

  it('carries the approval expiry from the policy that produced the verdict', () => {
    const out = evaluateTrustPolicy(
      { ...ALLOW_ALL, forkPolicy: 'hold', approvalExpiryHours: 12 },
      { ...SIGNALS, tier: 'unknown', isForkPR: true },
    );
    expect(out).toMatchObject({ action: 'hold', approvalExpiryHours: 12 });
  });

  it('carries no expiry in independent mode, matching the decision path', () => {
    // A `null` policy is independent mode: no upstream authority, so no
    // operator-set window. The hold-sizing site used to run its OWN store read
    // here and invent the 72h default, diverging from the decision path.
    const out = evaluateTrustPolicy(null, { ...SIGNALS, hasWorkflowModifications: true });
    expect(out).toMatchObject({ action: 'hold', approvalExpiryHours: null });
  });

  it('holds an unknown contributor', () => {
    const out = evaluateTrustPolicy(ALLOW_ALL, { ...SIGNALS, tier: 'unknown' });
    expect(out).toMatchObject({
      action: 'hold',
      reason: SecurityHoldReason.enum.unknown_contributor,
    });
  });

  it('treats an unresolved tier as unknown rather than as a pass', () => {
    // An unanswerable trust resolution must not collapse into "fine". This is
    // the fail-closed half of the evaluator that has no policy knob.
    const out = evaluateTrustPolicy(ALLOW_ALL, { ...SIGNALS, tier: undefined });
    expect(out).toMatchObject({
      action: 'hold',
      reason: SecurityHoldReason.enum.unknown_contributor,
    });
  });

  it('lets any reject beat any hold', () => {
    const out = evaluateTrustPolicy(
      { ...ALLOW_ALL, workflowChangePolicy: 'hold', forkPolicy: 'reject' },
      { tier: 'unknown', isForkPR: true, hasWorkflowModifications: true },
    );
    expect(out).toMatchObject({ action: 'reject', reason: SecurityHoldReason.enum.fork_pr });
  });

  it('names the first arm in order when several hold', () => {
    const out = evaluateTrustPolicy(
      { ...ALLOW_ALL, workflowChangePolicy: 'hold', forkPolicy: 'hold' },
      { tier: 'unknown', isForkPR: true, hasWorkflowModifications: true },
    );
    expect(out).toMatchObject({
      action: 'hold',
      reason: SecurityHoldReason.enum.workflow_modification,
    });
  });

  it('produces exactly one outcome for a PR that trips every arm', () => {
    const out = evaluateTrustPolicy(FAIL_CLOSED_POLICY, {
      tier: 'unknown',
      isForkPR: true,
      hasWorkflowModifications: true,
    });
    expect(out.action).toBe('hold');
    expect(Object.keys(out).sort()).toEqual(['action', 'approvalExpiryHours', 'message', 'reason']);
  });

  it('holds on a verdict it does not recognise, rather than passing', () => {
    // The policy columns are plain TEXT so a value written by a newer Platform
    // stays readable. An unrecognised verdict must not open the gate.
    const out = evaluateTrustPolicy(
      { ...ALLOW_ALL, forkPolicy: 'quarantine' as TrustPolicy['forkPolicy'] },
      { ...SIGNALS, isForkPR: true },
    );
    expect(out).toMatchObject({ action: 'hold', reason: SecurityHoldReason.enum.fork_pr });
  });

  it('never emits context_trust — that reason belongs to the context gate', () => {
    for (const tier of ['known', 'unknown', undefined] as const) {
      for (const isForkPR of [true, false]) {
        for (const hasWorkflowModifications of [true, false]) {
          const out = evaluateTrustPolicy(FAIL_CLOSED_POLICY, {
            tier,
            isForkPR,
            hasWorkflowModifications,
          });
          if (out.action !== 'pass') {
            expect(out.reason).not.toBe(SecurityHoldReason.enum.context_trust);
          }
        }
      }
    }
  });

  describe('null policy reproduces pre-change behavior', () => {
    it('holds a known contributor who modified workflows', () => {
      expect(
        evaluateTrustPolicy(null, { ...SIGNALS, hasWorkflowModifications: true }),
      ).toMatchObject({
        action: 'hold',
        reason: SecurityHoldReason.enum.workflow_modification,
      });
    });

    it('passes a fork PR with no workflow modifications', () => {
      expect(evaluateTrustPolicy(null, { ...SIGNALS, isForkPR: true })).toEqual({
        action: 'pass',
      });
    });

    it('passes an unknown contributor with no workflow modifications', () => {
      expect(evaluateTrustPolicy(null, { ...SIGNALS, tier: 'unknown' })).toEqual({
        action: 'pass',
      });
    });

    it('never rejects, whatever the signals', () => {
      for (const tier of ['known', 'unknown', undefined] as const) {
        const out = evaluateTrustPolicy(null, {
          tier,
          isForkPR: true,
          hasWorkflowModifications: true,
        });
        expect(out.action).not.toBe('reject');
      }
    });
  });
});

describe('resolveEffectivePolicy', () => {
  const stored = { ...ALLOW_ALL, source: 'platform' as const, updatedAt: new Date() };

  it('returns the stored policy whatever the mode', () => {
    for (const mode of OrchestratorMode.options) {
      expect(resolveEffectivePolicy(stored, mode)).toEqual(ALLOW_ALL);
    }
  });

  it('fails closed when Platform-attached with no stored row', () => {
    for (const mode of ['platform', 'hybrid', 'observed'] as const) {
      expect(resolveEffectivePolicy(null, mode)).toEqual(FAIL_CLOSED_POLICY);
    }
  });

  it('returns null in independent mode with no stored row', () => {
    expect(resolveEffectivePolicy(null, 'independent')).toBeNull();
  });

  it('covers every declared orchestrator mode', () => {
    // A new mode must make a deliberate fail-open/fail-closed choice rather
    // than defaulting to whichever branch it happens to fall through.
    for (const mode of OrchestratorMode.options) {
      const resolved = resolveEffectivePolicy(null, mode);
      if (mode === 'independent') expect(resolved).toBeNull();
      else expect(resolved).toEqual(FAIL_CLOSED_POLICY);
    }
  });

  it('fails closed to the strictest policy, never to an allow', () => {
    expect(FAIL_CLOSED_POLICY.forkPolicy).toBe('hold');
    expect(FAIL_CLOSED_POLICY.unknownContributorPolicy).toBe('hold');
    expect(FAIL_CLOSED_POLICY.workflowChangePolicy).toBe('hold');
  });
});

describe('policy key coverage', () => {
  // The defect this feature fixes was a whole pushed object going unread. This
  // test fails if the wire policy gains a key no decision site consumes.
  const CONSUMED_KEYS = [
    'forkPolicy',
    'unknownContributorPolicy',
    'workflowChangePolicy',
    'approvalExpiryHours',
  ] as const;

  it('consumes every key of the wire policy schema', () => {
    expect(Object.keys(trustPolicySchema.shape).sort()).toEqual([...CONSUMED_KEYS].sort());
  });

  it('changes its verdict when each decision key changes', () => {
    expect(
      evaluateTrustPolicy({ ...ALLOW_ALL, forkPolicy: 'hold' }, { ...SIGNALS, isForkPR: true })
        .action,
    ).toBe('hold');
    expect(
      evaluateTrustPolicy(
        { ...ALLOW_ALL, unknownContributorPolicy: 'reject' },
        { ...SIGNALS, tier: 'unknown' },
      ).action,
    ).toBe('reject');
    expect(
      evaluateTrustPolicy(
        { ...ALLOW_ALL, workflowChangePolicy: 'hold' },
        { ...SIGNALS, hasWorkflowModifications: true },
      ).action,
    ).toBe('hold');
    // `approvalExpiryHours` is consumed by the hold path, asserted in
    // dispatch-matched-workflow.test.ts.
  });
});
