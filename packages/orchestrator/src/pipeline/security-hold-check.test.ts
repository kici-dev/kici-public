import { describe, it, expect, vi } from 'vitest';
import {
  buildHoldEndedSummary,
  postedPendingSecurityCheck,
  settleSecurityCheckForDecision,
  settleSecurityCheckForOutcome,
  settleSecurityHoldCheck,
  HoldOutcome,
  SecurityCheckSettlement,
  type SecurityCheckHold,
} from './security-hold-check.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import {
  CheckRunConclusion,
  HoldScope,
  HoldType,
  installGateJobId,
  SECURITY_HOLD_JOB_IDS,
} from '@kici-dev/engine';

/**
 * A `held_runs` row with every column the predicate reads.
 *
 * `posted_pending_check` defaults to `null` — a row written before the column
 * existed, which is the only shape for which the shape derivation still
 * answers. Every row written since carries `false` until the post lands, so a
 * case that means "this hold posted" says so explicitly.
 */
function hold(overrides: Partial<SecurityCheckHold> = {}): SecurityCheckHold {
  return {
    id: 'hold-1',
    org_id: 'org-1',
    run_id: 'run-1',
    job_id: 'build (18)',
    hold_scope: HoldScope.enum.job,
    hold_type: HoldType.enum.security,
    approval_requirement: null,
    posted_pending_check: null,
    ...overrides,
  };
}

const REQUIREMENT = { clauses: [], expiresAt: 'x', reason: 'r' };

const RUN_ROW = {
  repo_identifier: 'acme/app',
  sha: 'cafebabe',
  routing_key: 'github:1',
  provider_context: { installationId: 42 },
};

function makeDb(opts: { runRow?: unknown; contenders?: unknown[] } = {}) {
  return createMockDb({
    selectFirstRow: 'runRow' in opts ? opts.runRow : RUN_ROW,
    selectRows: opts.contenders ?? [],
  }).db;
}

/**
 * Every hold shape, and whether it put a pending `KiCI Security` check on its
 * commit. Read off the three sites that post that pending status, not off the
 * queue type — which cannot make the distinction, because a security-typed
 * install gate carries `queue_type = 'security'` and posts nothing.
 */
describe('postedPendingSecurityCheck', () => {
  it("recognises the org trust policy's PR-wide hold", () => {
    expect(
      postedPendingSecurityCheck(
        hold({ hold_scope: HoldScope.enum.workflow, job_id: SECURITY_HOLD_JOB_IDS.fork_pr }),
      ),
    ).toBe(true);
  });

  it('rejects the workflow install gate, whose protection rule may be security-typed', () => {
    expect(
      postedPendingSecurityCheck(
        hold({
          hold_scope: HoldScope.enum.workflow,
          job_id: installGateJobId('CI'),
          // The install gate is written through `createHold`, so it carries a
          // requirement — the clause that would otherwise accept it. Its job id
          // is checked first for exactly this reason.
          approval_requirement: REQUIREMENT,
        }),
      ),
    ).toBe(false);
  });

  it("recognises the SDK's workflow-level requireApproval, whose job_id is a job name", () => {
    // Not a `SECURITY_HOLD_JOB_IDS` sentinel and not the install prefix — a
    // predicate keyed on the sentinel alone would miss it and leave its check
    // pending forever.
    expect(
      postedPendingSecurityCheck(
        hold({
          hold_scope: HoldScope.enum.workflow,
          job_id: 'release',
          hold_type: HoldType.enum.reviewer,
          approval_requirement: REQUIREMENT,
        }),
      ),
    ).toBe(true);
  });

  it('recognises a context reviewer hold and an SDK job requireApproval', () => {
    expect(
      postedPendingSecurityCheck(
        hold({ hold_type: HoldType.enum.reviewer, approval_requirement: REQUIREMENT }),
      ),
    ).toBe(true);
  });

  it("recognises the per-env gate's own security hold", () => {
    expect(postedPendingSecurityCheck(hold())).toBe(true);
  });

  it('rejects a wait-timer or concurrency hold, which posts nothing', () => {
    expect(postedPendingSecurityCheck(hold({ hold_type: HoldType.enum.timer }))).toBe(false);
    expect(postedPendingSecurityCheck(hold({ hold_type: HoldType.enum.concurrency }))).toBe(false);
    // The queue gate defaults an unnamed hold type to `reviewer` without
    // writing a requirement, and that shape posts nothing either.
    expect(postedPendingSecurityCheck(hold({ hold_type: HoldType.enum.reviewer }))).toBe(false);
  });

  it('rejects a step-scoped hold — the step bridge reaches no check poster', () => {
    expect(
      postedPendingSecurityCheck(
        hold({ hold_scope: HoldScope.enum.step, approval_requirement: REQUIREMENT }),
      ),
    ).toBe(false);
  });

  it('answers false for a shape that would post, whose post never landed', () => {
    // The mirror of the stuck check. Every shape above says what the code
    // MEANT to post; a provider that refused the call, or a dispatch that
    // reached no check poster, leaves the shape unchanged and the commit with
    // nothing. Terminalizing then CREATES a completed `KiCI Security` run on a
    // commit that never had one — a failing check on a pull request that
    // nothing put there.
    expect(postedPendingSecurityCheck(hold({ posted_pending_check: false }))).toBe(false);
    expect(
      postedPendingSecurityCheck(
        hold({
          hold_scope: HoldScope.enum.workflow,
          job_id: SECURITY_HOLD_JOB_IDS.fork_pr,
          posted_pending_check: false,
        }),
      ),
    ).toBe(false);
    expect(
      postedPendingSecurityCheck(
        hold({ approval_requirement: REQUIREMENT, posted_pending_check: false }),
      ),
    ).toBe(false);
  });

  it('answers true for a recorded post, whatever the shape would have said', () => {
    // The recorded fact is the answer in both directions, so a hold whose shape
    // reads "posts nothing" still settles a check it demonstrably posted.
    expect(
      postedPendingSecurityCheck(
        hold({ hold_type: HoldType.enum.timer, posted_pending_check: true }),
      ),
    ).toBe(true);
    expect(
      postedPendingSecurityCheck(
        hold({
          hold_scope: HoldScope.enum.workflow,
          job_id: installGateJobId('CI'),
          approval_requirement: REQUIREMENT,
          posted_pending_check: true,
        }),
      ),
    ).toBe(true);
  });
});

describe('buildHoldEndedSummary', () => {
  it('punctuates a rejecter reason that carries none', () => {
    // "…via /kici reject Push a new commit…" ran two sentences together.
    expect(
      buildHoldEndedSummary({
        outcome: HoldOutcome.Rejected,
        scope: HoldScope.enum.workflow,
        reason: 'Rejected by alice via /kici reject',
      }),
    ).toBe(
      'This run was cancelled before any job started. ' +
        'Rejected by alice via /kici reject. ' +
        'Push a new commit to have the pull request evaluated again.',
    );
  });

  it('leaves a reason that already ends in punctuation alone', () => {
    expect(
      buildHoldEndedSummary({
        outcome: HoldOutcome.Rejected,
        scope: HoldScope.enum.workflow,
        reason: 'Not this one.',
      }),
    ).toContain('Not this one. Push a new commit');
  });

  it('omits the reason clause entirely when there is none', () => {
    expect(
      buildHoldEndedSummary({ outcome: HoldOutcome.Rejected, scope: HoldScope.enum.workflow }),
    ).toBe(
      'This run was cancelled before any job started. ' +
        'Push a new commit to have the pull request evaluated again.',
    );
  });

  it('names the job, not the run, at job scope', () => {
    // A rejected job-scoped hold does not cancel the run — its sibling jobs
    // keep going — so the run-scoped sentence would be false.
    expect(
      buildHoldEndedSummary({ outcome: HoldOutcome.Rejected, scope: HoldScope.enum.job }),
    ).toContain('A job in this run was cancelled before it started.');
    expect(
      buildHoldEndedSummary({ outcome: HoldOutcome.Expired, scope: HoldScope.enum.job }),
    ).toContain('The approval window for a job in this run elapsed');
    // An approve at job scope releases ONE job. A still-pending step-approval
    // hold on the same run makes the run-wide sentence false.
    expect(
      buildHoldEndedSummary({
        outcome: HoldOutcome.Approved,
        scope: HoldScope.enum.job,
        actor: 'alice',
      }),
    ).toBe('Approved by alice. The hold was released, so the job it was holding can start.');
  });

  it('names the rejecter when the surface did not write one into the reason', () => {
    // The dashboard / CLI / MCP applier passes the actor and, with no reason
    // typed, nothing else — so without this clause the summary carried no
    // attribution at all, while `/kici reject` kept its own inside `reason`.
    expect(
      buildHoldEndedSummary({
        outcome: HoldOutcome.Rejected,
        scope: HoldScope.enum.job,
        actor: 'u-alice',
      }),
    ).toBe(
      'A job in this run was cancelled before it started. ' +
        'Rejected by u-alice. ' +
        'Push a new commit to have the pull request evaluated again.',
    );
    // The surface clause rides along with the actor, exactly as on an approve.
    expect(
      buildHoldEndedSummary({
        outcome: HoldOutcome.Rejected,
        scope: HoldScope.enum.job,
        actor: 'alice',
        via: '/kici reject',
        reason: 'Not this build',
      }),
    ).toContain('Rejected by alice via /kici reject. Not this build.');
  });

  it('does not double-attribute a reject whose reason already names its actor', () => {
    // `/kici reject` builds "Rejected by alice via /kici reject" as the hold's
    // stored reason and passes no `actor`, so the sentence appears once.
    expect(
      buildHoldEndedSummary({
        outcome: HoldOutcome.Rejected,
        scope: HoldScope.enum.workflow,
        reason: 'Rejected by alice via /kici reject',
      }),
    ).toBe(
      'This run was cancelled before any job started. ' +
        'Rejected by alice via /kici reject. ' +
        'Push a new commit to have the pull request evaluated again.',
    );
  });

  it('attributes an approval to its actor and surface', () => {
    expect(
      buildHoldEndedSummary({
        outcome: HoldOutcome.Approved,
        scope: HoldScope.enum.workflow,
        actor: 'alice',
        via: '/kici approve',
      }),
    ).toBe(
      'Approved by alice via /kici approve. ' +
        'The hold was released, so this run is no longer waiting for approval.',
    );
  });

  it('drops the surface clause when a decision arrived without one', () => {
    expect(
      buildHoldEndedSummary({
        outcome: HoldOutcome.Approved,
        scope: HoldScope.enum.job,
        actor: 'u-alice',
      }),
    ).toContain('Approved by u-alice. The hold was released');
  });
});

describe('settleSecurityHoldCheck', () => {
  function poster() {
    return vi.fn().mockResolvedValue(undefined);
  }

  const terminal = {
    status: CheckRunConclusion.enum.cancelled,
    title: 'Rejected',
    summary: 'because',
  };

  it('posts on the commit the HOLD ran against, through that run own routing key', async () => {
    const postCheckStatus = poster();
    const resolvePoster = vi.fn().mockReturnValue({ postCheckStatus });

    const result = await settleSecurityHoldCheck({
      db: makeDb(),
      resolvePoster,
      hold: hold(),
      ...terminal,
    });

    expect(result).toEqual({
      outcome: SecurityCheckSettlement.Posted,
      posted: true,
      commit: 'acme/app@cafebabe',
    });
    expect(resolvePoster).toHaveBeenCalledWith('github:1');
    expect(postCheckStatus).toHaveBeenCalledWith(
      'acme/app',
      'cafebabe',
      CheckRunConclusion.enum.cancelled,
      'Rejected',
      'because',
      { installationId: 42 },
    );
  });

  it('parses provider_context when the driver hands it back as a string', async () => {
    const postCheckStatus = poster();
    await settleSecurityHoldCheck({
      db: makeDb({ runRow: { ...RUN_ROW, provider_context: '{"installationId":7}' } }),
      resolvePoster: () => ({ postCheckStatus }) as never,
      hold: hold(),
      ...terminal,
    });
    expect(postCheckStatus.mock.calls[0][5]).toEqual({ installationId: 7 });
  });

  it('writes nothing for a hold that posted no pending check', async () => {
    const postCheckStatus = poster();
    const result = await settleSecurityHoldCheck({
      db: makeDb(),
      resolvePoster: () => ({ postCheckStatus }) as never,
      hold: hold({ hold_scope: HoldScope.enum.workflow, job_id: installGateJobId('CI') }),
      ...terminal,
    });
    expect(result.outcome).toBe(SecurityCheckSettlement.NotOwned);
    expect(postCheckStatus).not.toHaveBeenCalled();
  });

  it('leaves the check pending while another owning hold on the commit is pending', async () => {
    const postCheckStatus = poster();
    const result = await settleSecurityHoldCheck({
      db: makeDb({ contenders: [hold({ id: 'hold-2', job_id: 'build (20)' })] }),
      resolvePoster: () => ({ postCheckStatus }) as never,
      hold: hold(),
      ...terminal,
    });
    expect(result.outcome).toBe(SecurityCheckSettlement.Contended);
    expect(result.posted).toBe(false);
    expect(postCheckStatus).not.toHaveBeenCalled();
  });

  it('ignores the ending hold itself in the contention query', async () => {
    // The row is still `pending` in a sweep that has not flipped its batch yet,
    // so without the exclusion every hold would refuse on account of itself.
    const postCheckStatus = poster();
    const result = await settleSecurityHoldCheck({
      db: makeDb({ contenders: [hold()] }),
      resolvePoster: () => ({ postCheckStatus }) as never,
      hold: hold(),
      ...terminal,
    });
    expect(result.outcome).toBe(SecurityCheckSettlement.Posted);
  });

  it('ignores holds the caller names in excludeHoldIds', async () => {
    const postCheckStatus = poster();
    const result = await settleSecurityHoldCheck({
      db: makeDb({ contenders: [hold({ id: 'hold-also-expiring' })] }),
      resolvePoster: () => ({ postCheckStatus }) as never,
      hold: hold(),
      excludeHoldIds: ['hold-also-expiring'],
      ...terminal,
    });
    expect(result.outcome).toBe(SecurityCheckSettlement.Posted);
  });

  it('ignores a pending hold that posted no check of its own', async () => {
    // The control for the contention cases: presence is not ownership.
    const postCheckStatus = poster();
    const result = await settleSecurityHoldCheck({
      db: makeDb({ contenders: [hold({ id: 'hold-2', hold_type: HoldType.enum.timer })] }),
      resolvePoster: () => ({ postCheckStatus }) as never,
      hold: hold(),
      ...terminal,
    });
    expect(result.outcome).toBe(SecurityCheckSettlement.Posted);
  });

  it('writes nothing for a hold whose pending post never reached the provider', async () => {
    // The fabrication case: the shape says this hold posts, the record says the
    // post did not land. `postCheckStatus` CREATES the run when it finds none,
    // so posting a terminal status here would put a completed `KiCI Security`
    // check on a commit that never carried one.
    const postCheckStatus = poster();
    const result = await settleSecurityHoldCheck({
      db: makeDb(),
      resolvePoster: () => ({ postCheckStatus }) as never,
      hold: hold({ posted_pending_check: false }),
      ...terminal,
    });
    expect(result).toEqual({ outcome: SecurityCheckSettlement.NotOwned, posted: false });
    expect(postCheckStatus).not.toHaveBeenCalled();
  });

  it('ignores a pending hold whose own post never landed', async () => {
    // The same fact read through the contention query. A hold that posted
    // nothing owns nothing, so it cannot hold the check open for the hold that
    // did — which would leave a real pending check with no remaining writer.
    const postCheckStatus = poster();
    const result = await settleSecurityHoldCheck({
      db: makeDb({
        contenders: [hold({ id: 'hold-2', job_id: 'build (20)', posted_pending_check: false })],
      }),
      resolvePoster: () => ({ postCheckStatus }) as never,
      hold: hold({ posted_pending_check: true }),
      ...terminal,
    });
    expect(result.outcome).toBe(SecurityCheckSettlement.Posted);
  });

  it('projects every column the ownership predicate reads into the contention query', async () => {
    // The contention query names its columns, so one the predicate reads and
    // the projection omits arrives `undefined` — and the predicate then answers
    // from a partial row with nothing failing at runtime. No test driven through
    // `createMockDb` can see that: the harness returns `selectRows` verbatim,
    // never consulting the select list. The compiler does catch a dropped column
    // today, but only because every field of `SecurityCheckHold` is REQUIRED —
    // make one optional and the projection may silently shrink again. The
    // fixture's own keys are the list, so a field added to that interface must
    // be projected to pass here.
    const mock = createMockDb({ selectFirstRow: RUN_ROW, selectRows: [] });
    await settleSecurityHoldCheck({
      db: mock.db,
      resolvePoster: () => ({ postCheckStatus: vi.fn().mockResolvedValue(undefined) }) as never,
      hold: hold({ posted_pending_check: true }),
      ...terminal,
    });

    const projected = mock.mocks.select.mock.calls.flatMap((c) => c[0] as string[]);
    for (const column of Object.keys(hold())) {
      expect(projected).toContain(`held_runs.${column}`);
    }
  });

  it('skips a commit the caller already settled in the same pass', async () => {
    const postCheckStatus = poster();
    const result = await settleSecurityHoldCheck({
      db: makeDb(),
      resolvePoster: () => ({ postCheckStatus }) as never,
      hold: hold(),
      skipCommits: new Set(['acme/app@cafebabe']),
      ...terminal,
    });
    expect(result.outcome).toBe(SecurityCheckSettlement.AlreadySettled);
    expect(postCheckStatus).not.toHaveBeenCalled();
  });

  it('reports rather than throws when the run row is gone', async () => {
    const result = await settleSecurityHoldCheck({
      db: makeDb({ runRow: undefined }),
      resolvePoster: () => ({ postCheckStatus: poster() }) as never,
      hold: hold(),
      ...terminal,
    });
    expect(result).toEqual({ outcome: SecurityCheckSettlement.NoCommit, posted: false });
  });

  it('reports rather than throws when the provider refuses the write', async () => {
    const result = await settleSecurityHoldCheck({
      db: makeDb(),
      resolvePoster: () =>
        ({ postCheckStatus: vi.fn().mockRejectedValue(new Error('GitHub 500')) }) as never,
      hold: hold(),
      ...terminal,
    });
    expect(result).toEqual({ outcome: SecurityCheckSettlement.Failed, posted: false });
  });

  it('names no commit, and posts nothing, when there is no database', async () => {
    // The commit coordinates come from `execution_runs`, so with no database in
    // reach there is nothing to address a check run to.
    const postCheckStatus = poster();
    const result = await settleSecurityHoldCheck({
      db: undefined,
      resolvePoster: () => ({ postCheckStatus }) as never,
      hold: hold(),
      ...terminal,
    });
    expect(result).toEqual({ outcome: SecurityCheckSettlement.NoCommit, posted: false });
    expect(postCheckStatus).not.toHaveBeenCalled();
  });
});

describe('settleSecurityCheckForOutcome', () => {
  it.each([
    [HoldOutcome.Approved, CheckRunConclusion.enum.success, 'Approved'],
    [HoldOutcome.Rejected, CheckRunConclusion.enum.cancelled, 'Rejected'],
    [HoldOutcome.Expired, CheckRunConclusion.enum.timed_out, 'Approval window elapsed'],
  ])('concludes a %s hold as %s', async (outcome, conclusion, title) => {
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    await settleSecurityCheckForOutcome({
      db: makeDb(),
      resolvePoster: () => ({ postCheckStatus }) as never,
      hold: hold(),
      outcome,
      actor: 'alice',
    });
    expect(postCheckStatus.mock.calls[0][2]).toBe(conclusion);
    expect(postCheckStatus.mock.calls[0][3]).toBe(title);
  });
});

/**
 * The applier's entry point holds a KiCI subject id, and the summary it produces
 * is published on a public commit check. Every case below asserts on the SUMMARY
 * the poster received, not on the argument handed inward — a subject that leaks
 * leaks in that string.
 */
describe('settleSecurityCheckForDecision', () => {
  const settle = async (
    args: {
      actorSub?: string;
      resolveDisplayName?: (sub: string) => string | undefined;
      outcome?: HoldOutcome;
    } = {},
  ) => {
    const postCheckStatus = vi.fn().mockResolvedValue(undefined);
    await settleSecurityCheckForDecision({
      db: makeDb(),
      resolvePoster: () => ({ postCheckStatus }) as never,
      resolveDisplayName: args.resolveDisplayName ?? (() => 'alice'),
      hold: hold(),
      outcome: args.outcome ?? HoldOutcome.Approved,
      ...(args.actorSub !== undefined && { actorSub: args.actorSub }),
    });
    return postCheckStatus.mock.calls[0]?.[4] as string;
  };

  it('names the account the directory links the subject to', async () => {
    expect(await settle({ actorSub: 'b2c3d4e5-0000-4000-8000-111122223333' })).toContain(
      'Approved by alice.',
    );
  });

  it('names an approver generically when the subject resolves to no account', async () => {
    // The leak this closes: the raw subject reaching contributor-facing copy on
    // a commit check anyone can open. Unattributed is the safe answer, not a
    // fallback to the id.
    const summary = await settle({
      actorSub: 'b2c3d4e5-0000-4000-8000-111122223333',
      resolveDisplayName: () => undefined,
    });
    expect(summary).toContain('Approved by an approver.');
    expect(summary).not.toContain('b2c3d4e5');
  });

  it('drops a reject attribution entirely when the subject resolves to no account', async () => {
    const summary = await settle({
      actorSub: 'b2c3d4e5-0000-4000-8000-111122223333',
      resolveDisplayName: () => undefined,
      outcome: HoldOutcome.Rejected,
    });
    expect(summary).not.toContain('Rejected by');
    expect(summary).not.toContain('b2c3d4e5');
  });

  it('resolves nothing when the caller supplied no subject', async () => {
    const resolveDisplayName = vi.fn(() => 'alice');
    const summary = await settle({ resolveDisplayName });
    expect(resolveDisplayName).not.toHaveBeenCalled();
    expect(summary).toContain('Approved by an approver.');
  });
});
