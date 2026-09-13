import { describe, it, expect } from 'vitest';
import type { ApprovalRequirement } from '@kici-dev/engine';
import {
  canApprove,
  evaluate,
  isClauseSatisfied,
  type RecordedDecision,
  type TeamMembershipLookup,
} from './approval-resolver.js';

/** A membership lookup where `leads` = {alice, cto} and every other team is empty. */
const lookup: TeamMembershipLookup = (team) =>
  new Set(team === 'leads' ? ['u-alice', 'u-cto'] : []);

const approve = (sub: string): RecordedDecision => ({
  approver_user_id: sub,
  decision: 'approve',
});
const reject = (sub: string): RecordedDecision => ({ approver_user_id: sub, decision: 'reject' });

function req(clauses: ApprovalRequirement['clauses']): ApprovalRequirement {
  return { clauses, expiresAt: '2030-01-01T00:00:00.000Z', reason: '' };
}

describe('isClauseSatisfied', () => {
  it('team clause satisfied iff a decision approver is in the team', () => {
    expect(isClauseSatisfied({ team: 'leads' }, [approve('u-alice')], lookup)).toBe(true);
    expect(isClauseSatisfied({ team: 'leads' }, [approve('u-bob')], lookup)).toBe(false);
  });

  it('user clause satisfied iff that exact user approved', () => {
    expect(isClauseSatisfied({ user: 'u-cto' }, [approve('u-cto')], lookup)).toBe(true);
    expect(isClauseSatisfied({ user: 'u-cto' }, [approve('u-alice')], lookup)).toBe(false);
  });

  it('a reject decision never satisfies a clause', () => {
    expect(isClauseSatisfied({ team: 'leads' }, [reject('u-alice')], lookup)).toBe(false);
  });
});

describe('evaluate', () => {
  it('AND across clauses; one approver may satisfy many', () => {
    const r = req([{ team: 'leads' }, { user: 'u-cto' }]);
    // u-cto is in leads AND is u-cto, so a single approve satisfies both clauses.
    const result = evaluate(r, [approve('u-cto')], lookup);
    expect(result.satisfied).toBe(true);
    expect(result.rejected).toBe(false);
    expect(result.perClause).toHaveLength(2);
    expect(result.perClause.every((c) => c.satisfied)).toBe(true);
  });

  it('AND not satisfied until every clause has an eligible approver', () => {
    const r = req([{ team: 'leads' }, { user: 'u-bob' }]);
    const result = evaluate(r, [approve('u-alice')], lookup);
    expect(result.satisfied).toBe(false);
    // leads clause satisfied by alice; u-bob clause still open.
    expect(result.perClause.find((c) => 'team' in c.clause)?.satisfied).toBe(true);
    expect(result.perClause.find((c) => 'user' in c.clause)?.satisfied).toBe(false);
  });

  it('empty clauses → satisfied by ANY single approve decision', () => {
    const r = req([]);
    expect(evaluate(r, [], lookup).satisfied).toBe(false);
    expect(evaluate(r, [approve('u-anyone')], lookup).satisfied).toBe(true);
  });

  it('a single reject short-circuits to rejected', () => {
    const r = req([{ team: 'leads' }]);
    const result = evaluate(r, [approve('u-alice'), reject('u-cto')], lookup);
    expect(result.rejected).toBe(true);
    expect(result.satisfied).toBe(false);
  });

  it('records who satisfied each clause', () => {
    const r = req([{ team: 'leads' }]);
    const result = evaluate(r, [approve('u-alice')], lookup);
    expect(result.perClause[0]?.by).toBe('u-alice');
  });
});

describe('canApprove', () => {
  const r = req([{ team: 'leads' }, { user: 'u-bob' }]);

  it('false when the actor is eligible for no unsatisfied clause', () => {
    // u-alice satisfies the leads clause already; the only open clause is
    // {user: u-bob}, for which u-alice is not eligible.
    expect(
      canApprove('u-alice', r, [approve('u-alice')], lookup, {
        triggererSub: 'u-trigger',
        allowSelfApproval: true,
      }),
    ).toBe(false);
  });

  it('true when the actor is eligible for at least one unsatisfied clause', () => {
    expect(
      canApprove('u-cto', r, [], lookup, { triggererSub: 'u-trigger', allowSelfApproval: true }),
    ).toBe(true);
  });

  it('false when actor is the triggerer and self-approval is off', () => {
    expect(
      canApprove('u-cto', r, [], lookup, { triggererSub: 'u-cto', allowSelfApproval: false }),
    ).toBe(false);
  });

  it('true when actor is the triggerer but self-approval is on', () => {
    expect(
      canApprove('u-cto', r, [], lookup, { triggererSub: 'u-cto', allowSelfApproval: true }),
    ).toBe(true);
  });

  it('empty clauses → any user (not the triggerer when self-approval off) may approve', () => {
    const empty = req([]);
    expect(
      canApprove('u-anyone', empty, [], lookup, {
        triggererSub: 'u-trigger',
        allowSelfApproval: false,
      }),
    ).toBe(true);
    expect(
      canApprove('u-trigger', empty, [], lookup, {
        triggererSub: 'u-trigger',
        allowSelfApproval: false,
      }),
    ).toBe(false);
  });
});
