import { describe, it, expect, vi } from 'vitest';
import { parseKiciCommand, handleApprovalComment } from './comment-handler.js';
import type { HandleApprovalCommentParams } from './comment-handler.js';
import type { IdentityLink, PermissionLevel } from './trust-resolver.js';
import {
  CheckRunConclusion,
  HoldScope,
  HoldType,
  INSTALL_JOB_ID_PREFIX,
  installGateJobId,
  SECURITY_HOLD_JOB_IDS,
  TriggerSource,
} from '@kici-dev/engine';
import { createMockDb } from '../__test-helpers__/mock-db.js';

vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  };
});

describe('parseKiciCommand', () => {
  it('parses /kici approve', () => {
    expect(parseKiciCommand('/kici approve')).toEqual({ action: 'approve' });
  });

  it('parses /kici reject', () => {
    expect(parseKiciCommand('/kici reject')).toEqual({ action: 'reject' });
  });

  it('parses /kici approve with run ID', () => {
    expect(parseKiciCommand('/kici approve run-123')).toEqual({
      action: 'approve',
      runId: 'run-123',
    });
  });

  it('returns null for non-kici comments', () => {
    expect(parseKiciCommand('Some other comment')).toBeNull();
  });

  it('parses command at start of any line (multiline)', () => {
    const body = 'Looks good to me!\n/kici approve\nThanks';
    expect(parseKiciCommand(body)).toEqual({ action: 'approve' });
  });

  it('handles case-insensitive command', () => {
    expect(parseKiciCommand('/kici APPROVE')).toEqual({ action: 'approve' });
    expect(parseKiciCommand('/kici Reject')).toEqual({ action: 'reject' });
  });

  it('ignores partial matches', () => {
    expect(parseKiciCommand('not /kici approve')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseKiciCommand('')).toBeNull();
  });

  it('ignores /kici without command', () => {
    expect(parseKiciCommand('/kici')).toBeNull();
  });
});

describe('handleApprovalComment', () => {
  function createMockHeldRunStore() {
    return {
      // The org-wide list must NOT be called by the handler anymore — kept on
      // the mock only so tests can assert it is never reached.
      listByQueueType: vi.fn().mockResolvedValue([]),
      listPendingSecurityHoldsForPr: vi.fn().mockResolvedValue([]),
      approveByQueueType: vi.fn().mockResolvedValue({}),
      reject: vi.fn().mockResolvedValue({}),
    } as any;
  }

  /**
   * The `execution_runs` row every settled security check is addressed from —
   * the hold's OWN commit, which is not necessarily the PR head at comment time.
   */
  const RUN_ROW = {
    repo_identifier: 'owner/repo',
    sha: 'sha1',
    routing_key: 'github:1',
    provider_context: { installationId: 42 },
  };

  /**
   * A database whose `execution_runs` lookup answers with `RUN_ROW` and whose
   * contention query answers with `contenders` — the other holds still pending
   * on the same commit. The two are told apart by their terminal: the run
   * lookup ends in `executeTakeFirst`, the contention query in `execute`.
   */
  function makeDb(contenders: unknown[] = []) {
    return createMockDb({ selectFirstRow: RUN_ROW, selectRows: contenders }).db;
  }

  /** A `held_runs` row of a hold that DID post a pending `KiCI Security` check. */
  function securityHoldRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'hold-1',
      org_id: 'org-1',
      run_id: 'run-1',
      job_id: 'build (18)',
      queue_type: 'security',
      status: 'pending',
      hold_scope: HoldScope.enum.job,
      hold_type: HoldType.enum.security,
      trigger_source: TriggerSource.enum.context,
      approval_requirement: null,
      step_index: null,
      ...overrides,
    };
  }

  function makePoster() {
    return {
      provider: 'github' as const,
      postCheckStatus: vi.fn().mockResolvedValue(undefined),
      postWorkflowModificationCheck: vi.fn().mockResolvedValue(undefined),
    };
  }

  const defaultLinks: IdentityLink[] = [
    {
      userId: 'user-1',
      provider: 'github',
      providerUsername: 'alice',
      providerUserId: '1001',
    },
  ];
  const defaultPermissions = new Map<string, PermissionLevel>([['user-1', 'write']]);

  function createBaseParams(
    overrides?: Partial<HandleApprovalCommentParams>,
  ): HandleApprovalCommentParams {
    return {
      commentBody: '/kici approve',
      commenterUsername: 'alice',
      commenterUserId: '1001',
      provider: 'github',
      repoIdentifier: 'owner/repo',
      prNumber: 42,
      orgId: 'org-1',
      identityLinks: defaultLinks,
      orgMemberPermissions: defaultPermissions,
      heldRunStore: createMockHeldRunStore(),
      db: makeDb(),
      ...overrides,
    };
  }

  it('returns not handled when no /kici command in comment', async () => {
    const params = createBaseParams({ commentBody: 'LGTM' });
    const result = await handleApprovalComment(params);
    expect(result.handled).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('returns not handled when commenter has no identity link', async () => {
    const params = createBaseParams({
      commenterUsername: 'unknown-user',
      commenterUserId: '99999',
    });
    const result = await handleApprovalComment(params);
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('No identity link for commenter');
  });

  it('returns not handled when commenter has ci_trust:read', async () => {
    const params = createBaseParams({
      commenterUsername: 'bob',
      commenterUserId: '2002',
      identityLinks: [
        { userId: 'user-2', provider: 'github', providerUsername: 'bob', providerUserId: '2002' },
      ],
      orgMemberPermissions: new Map([['user-2', 'read']]),
    });
    const result = await handleApprovalComment(params);
    expect(result.handled).toBe(false);
    expect(result.reason).toBe('Insufficient ci_trust level');
  });

  it('approves security hold with ci_trust:write commenter', async () => {
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      { id: 'hold-1', run_id: 'run-1', queue_type: 'security', status: 'pending' },
    ]);

    const params = createBaseParams({ heldRunStore: store });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).toHaveBeenCalledWith('org-1', 'hold-1', 'user-1', 'security');
  });

  it('RESUMES the approved job, not just the hold row', async () => {
    // Approving used to flip the row and post a green check while dispatching
    // nothing: the gated work never ran, and the check said otherwise. The
    // signal is routed the same way a reviewer approval is.
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      {
        id: 'hold-1',
        run_id: 'run-1',
        job_id: 'deploy',
        queue_type: 'security',
        status: 'pending',
        hold_scope: 'job',
        trigger_source: 'context',
        step_index: null,
      },
    ]);
    const onJobRelease = vi.fn().mockResolvedValue(undefined);

    const result = await handleApprovalComment({
      ...createBaseParams({ heldRunStore: store }),
      onJobRelease,
    });

    expect(result.handled).toBe(true);
    expect(onJobRelease).toHaveBeenCalledTimes(1);
    expect(onJobRelease.mock.calls[0][0]).toMatchObject({ runId: 'run-1', jobId: 'deploy' });
  });

  it('RESUMES a workflow-scoped hold through the workflow path, not the job path', async () => {
    // The org trust policy's PR-wide hold fires before any job is materialized,
    // so its `job_id` is a sentinel no `storePendingJobContext` call ever
    // writes. Routing it to `dispatchReadyJob` therefore looked up a context
    // that cannot exist and returned, and the approved run never ran.
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      {
        id: 'hold-1',
        run_id: 'run-1',
        job_id: SECURITY_HOLD_JOB_IDS.fork_pr,
        queue_type: 'security',
        status: 'pending',
        hold_scope: HoldScope.enum.workflow,
        trigger_source: TriggerSource.enum.context,
        step_index: null,
      },
    ]);
    const onJobRelease = vi.fn().mockResolvedValue(undefined);
    const onWorkflowRelease = vi.fn().mockResolvedValue(undefined);

    const result = await handleApprovalComment({
      ...createBaseParams({ heldRunStore: store }),
      onJobRelease,
      onWorkflowRelease,
    });

    expect(result.handled).toBe(true);
    expect(onWorkflowRelease).toHaveBeenCalledTimes(1);
    expect(onWorkflowRelease.mock.calls[0][0]).toMatchObject({
      holdId: 'hold-1',
      runId: 'run-1',
      jobId: SECURITY_HOLD_JOB_IDS.fork_pr,
      scope: HoldScope.enum.workflow,
    });
    // The job path is not a fallback here: taking both would double-dispatch.
    expect(onJobRelease).not.toHaveBeenCalled();
  });

  it('CANCELS a rejected workflow-scoped hold so its stored context is dropped', async () => {
    // A workflow-scoped hold owns a live `held` run row and a stored dispatch
    // context. Flipping only the hold row leaves both behind forever.
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      {
        id: 'hold-1',
        run_id: 'run-1',
        job_id: SECURITY_HOLD_JOB_IDS.fork_pr,
        queue_type: 'security',
        status: 'pending',
        hold_scope: HoldScope.enum.workflow,
        trigger_source: TriggerSource.enum.context,
        step_index: null,
      },
    ]);
    const onWorkflowRelease = vi.fn().mockResolvedValue(undefined);
    const onWorkflowReject = vi.fn().mockResolvedValue(true);

    const result = await handleApprovalComment({
      ...createBaseParams({ commentBody: '/kici reject', heldRunStore: store }),
      onWorkflowRelease,
      onWorkflowReject,
    });

    expect(result.handled).toBe(true);
    expect(onWorkflowReject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'hold-1',
        run_id: 'run-1',
        job_id: SECURITY_HOLD_JOB_IDS.fork_pr,
      }),
      'Rejected by alice via /kici reject',
    );
    // Rejection must never dispatch.
    expect(onWorkflowRelease).not.toHaveBeenCalled();
  });

  it('does NOT cancel the run when a rejected hold is job-scoped', async () => {
    // The control for the case above: a job-scoped hold owns no stored workflow
    // context and no run-wide cancellation, so rejecting one must leave the run
    // alone. Without it the assertion above would pass on a handler that
    // cancelled every rejection.
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      {
        id: 'hold-1',
        run_id: 'run-1',
        job_id: 'deploy',
        queue_type: 'security',
        status: 'pending',
        hold_scope: HoldScope.enum.job,
        trigger_source: TriggerSource.enum.context,
        step_index: null,
      },
    ]);
    const onWorkflowReject = vi.fn().mockResolvedValue(true);

    const result = await handleApprovalComment({
      ...createBaseParams({ commentBody: '/kici reject', heldRunStore: store }),
      onWorkflowReject,
    });

    expect(result.handled).toBe(true);
    expect(store.reject).toHaveBeenCalledTimes(1);
    expect(onWorkflowReject).not.toHaveBeenCalled();
  });

  it('still approves when no resume handler is wired', async () => {
    // The control: an orchestrator without the dispatch wiring degrades to the
    // old flip-and-report rather than failing the comment outright.
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      {
        id: 'hold-1',
        run_id: 'run-1',
        job_id: 'deploy',
        queue_type: 'security',
        status: 'pending',
      },
    ]);

    const result = await handleApprovalComment(createBaseParams({ heldRunStore: store }));

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).toHaveBeenCalledTimes(1);
  });

  it('rejects security hold on /kici reject', async () => {
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      { id: 'hold-1', run_id: 'run-1', queue_type: 'security', status: 'pending' },
    ]);

    const params = createBaseParams({
      commentBody: '/kici reject',
      heldRunStore: store,
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.reject).toHaveBeenCalledWith(
      'org-1',
      'hold-1',
      'Rejected by alice via /kici reject',
    );
  });

  it('handles no pending security holds gracefully', async () => {
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([]);

    const params = createBaseParams({ heldRunStore: store });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).not.toHaveBeenCalled();
  });

  it('filters to specific run when runId provided', async () => {
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      { id: 'hold-1', run_id: 'run-1', queue_type: 'security', status: 'pending' },
      { id: 'hold-2', run_id: 'run-2', queue_type: 'security', status: 'pending' },
    ]);

    const params = createBaseParams({
      commentBody: '/kici approve run-1',
      heldRunStore: store,
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).toHaveBeenCalledTimes(1);
    expect(store.approveByQueueType).toHaveBeenCalledWith('org-1', 'hold-1', 'user-1', 'security');
  });

  it('allows ci_trust:admin to approve', async () => {
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      { id: 'hold-1', run_id: 'run-1', queue_type: 'security', status: 'pending' },
    ]);

    const params = createBaseParams({
      commenterUsername: 'admin',
      commenterUserId: '9999',
      identityLinks: [
        {
          userId: 'admin-1',
          provider: 'github',
          providerUsername: 'admin',
          providerUserId: '9999',
        },
      ],
      orgMemberPermissions: new Map([['admin-1', 'admin']]),
      heldRunStore: store,
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).toHaveBeenCalled();
  });

  it('completes the security check on approval, on the hold OWN commit', async () => {
    // Not `params.repoIdentifier` + the PR head: the check to terminalize is
    // the one the hold posted, which lives on the commit that hold's run acted
    // on. A contributor who pushed again while the hold was pending would
    // otherwise get a second `KiCI Security` run on the new head while the real
    // one stayed pending on the old one.
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      securityHoldRow({ hold_scope: HoldScope.enum.job, job_id: 'deploy' }),
    ]);

    const mockPoster = makePoster();
    const result = await handleApprovalComment(
      createBaseParams({ heldRunStore: store, resolvePoster: () => mockPoster }),
    );

    expect(result.handled).toBe(true);
    expect(mockPoster.postCheckStatus).toHaveBeenCalledWith(
      'owner/repo',
      'sha1',
      CheckRunConclusion.enum.success,
      'Approved',
      expect.stringContaining('Approved by alice via /kici approve.'),
      { installationId: 42 },
    );
  });

  it('completes the security check as cancelled on rejection, not failure', async () => {
    // One vocabulary for one event: a rejection concludes `cancelled` on the
    // security check exactly as it does on the run's `kici/…` checks, whatever
    // the hold's scope. The reason is punctuated so it cannot run into the
    // sentence that follows it.
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      securityHoldRow({ hold_scope: HoldScope.enum.job, job_id: 'deploy' }),
    ]);

    const mockPoster = makePoster();
    const result = await handleApprovalComment(
      createBaseParams({
        commentBody: '/kici reject',
        heldRunStore: store,
        resolvePoster: () => mockPoster,
      }),
    );

    expect(result.handled).toBe(true);
    expect(mockPoster.postCheckStatus).toHaveBeenCalledWith(
      'owner/repo',
      'sha1',
      CheckRunConclusion.enum.cancelled,
      'Rejected',
      'A job in this run was cancelled before it started. ' +
        'Rejected by alice via /kici reject. ' +
        'Push a new commit to have the pull request evaluated again.',
      { installationId: 42 },
    );
  });

  it('does not post check status when all hold operations fail', async () => {
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      securityHoldRow({ id: 'hold-1', run_id: 'run-1' }),
      securityHoldRow({ id: 'hold-2', run_id: 'run-2' }),
    ]);
    store.approveByQueueType.mockRejectedValue(new Error('DB connection lost'));

    const mockPoster = makePoster();
    const result = await handleApprovalComment(
      createBaseParams({ heldRunStore: store, resolvePoster: () => mockPoster }),
    );

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).toHaveBeenCalledTimes(2);
    expect(mockPoster.postCheckStatus).not.toHaveBeenCalled();
  });

  // ── Who writes the `KiCI Security` check ──────────────────────────────────

  describe('the KiCI Security check has exactly one writer per path', () => {
    /**
     * One pending hold of the given scope + `job_id`, as the PR-scoped list
     * returns it. An install-gate row carries an `approval_requirement`,
     * because `holdWorkflowForInstallGate` writes it through `createHold` — and
     * that is the clause which would otherwise accept it, so a row without one
     * would pass these tests even with the install-gate guard removed.
     */
    function storeWithHold(holdScope: string, jobId: string) {
      const store = createMockHeldRunStore();
      store.listPendingSecurityHoldsForPr.mockResolvedValue([
        securityHoldRow({
          hold_scope: holdScope,
          job_id: jobId,
          ...(jobId.startsWith(INSTALL_JOB_ID_PREFIX) && {
            approval_requirement: { clauses: [], expiresAt: 'x', reason: 'r' },
          }),
        }),
      ]);
      return store;
    }

    it('posts nothing for a rejected trust-policy hold whose delegate wrote the check', async () => {
      // `rejectWorkflow` completes that hold's check as `cancelled`, under the
      // same summary the run's `kici/…` checks carry. A post here too would
      // make two writers of one check run, the second replacing the first's
      // title, summary and conclusion with a different phrasing of one event.
      const store = storeWithHold(HoldScope.enum.workflow, SECURITY_HOLD_JOB_IDS.fork_pr);
      const poster = makePoster();
      const onWorkflowReject = vi.fn().mockResolvedValue(true);

      await handleApprovalComment({
        ...createBaseParams({ commentBody: '/kici reject', heldRunStore: store }),
        resolvePoster: () => poster,
        onWorkflowReject,
      });

      expect(onWorkflowReject).toHaveBeenCalledTimes(1);
      expect(poster.postCheckStatus).not.toHaveBeenCalled();
    });

    it('posts for the same hold when the delegate declined to write one', async () => {
      // The suppression is bound to a check having been WRITTEN, not to the
      // delegate resolving. A delegate that ran and wrote nothing leaves the
      // hold this handler's to report, so this is the control that keeps the
      // case above from passing on a handler that had simply stopped posting
      // for every delegated rejection.
      const store = storeWithHold(HoldScope.enum.workflow, SECURITY_HOLD_JOB_IDS.fork_pr);
      const poster = makePoster();
      const onWorkflowReject = vi.fn().mockResolvedValue(false);

      await handleApprovalComment({
        ...createBaseParams({ commentBody: '/kici reject', heldRunStore: store }),
        resolvePoster: () => poster,
        onWorkflowReject,
      });

      expect(onWorkflowReject).toHaveBeenCalledTimes(1);
      expect(poster.postCheckStatus).toHaveBeenCalledTimes(1);
      expect(poster.postCheckStatus.mock.calls[0][3]).toBe('Rejected');
    });

    it('posts for the same hold when no delegate is wired', async () => {
      const store = storeWithHold(HoldScope.enum.workflow, SECURITY_HOLD_JOB_IDS.fork_pr);
      const poster = makePoster();

      await handleApprovalComment({
        ...createBaseParams({ commentBody: '/kici reject', heldRunStore: store }),
        resolvePoster: () => poster,
      });

      expect(poster.postCheckStatus).toHaveBeenCalledTimes(1);
      expect(poster.postCheckStatus.mock.calls[0][3]).toBe('Rejected');
    });

    it('posts for the same hold when the delegate failed', async () => {
      // A delegate that threw completed no check, so the hold is this
      // handler's to report on after all.
      const store = storeWithHold(HoldScope.enum.workflow, SECURITY_HOLD_JOB_IDS.fork_pr);
      const poster = makePoster();
      const onWorkflowReject = vi.fn().mockRejectedValue(new Error('DB connection lost'));

      await handleApprovalComment({
        ...createBaseParams({ commentBody: '/kici reject', heldRunStore: store }),
        resolvePoster: () => poster,
        onWorkflowReject,
      });

      expect(poster.postCheckStatus).toHaveBeenCalledTimes(1);
    });

    it('posts nothing for a rejected install-gate hold, even with no delegate wired', async () => {
      // `postCheckStatus` CREATES the named run when it finds none. A workflow
      // install gate whose context protection rule is a security hold lands in
      // this handler's queue-type-scoped set and posts no pending check of its
      // own, so a post here fabricates a failing `KiCI Security` check on a
      // commit that never had one. No delegate is wired, so nothing else can
      // account for the silence.
      const store = storeWithHold(HoldScope.enum.workflow, installGateJobId('CI'));
      const poster = makePoster();

      const result = await handleApprovalComment({
        ...createBaseParams({ commentBody: '/kici reject', heldRunStore: store }),
        resolvePoster: () => poster,
      });

      // The hold itself was still rejected — only the check post is withheld.
      expect(result.handled).toBe(true);
      expect(store.reject).toHaveBeenCalledTimes(1);
      expect(poster.postCheckStatus).not.toHaveBeenCalled();
    });

    it('posts nothing for an APPROVED install-gate hold either', async () => {
      const store = storeWithHold(HoldScope.enum.workflow, installGateJobId('CI'));
      const poster = makePoster();

      await handleApprovalComment({
        ...createBaseParams({ heldRunStore: store }),
        resolvePoster: () => poster,
      });

      expect(store.approveByQueueType).toHaveBeenCalledTimes(1);
      expect(poster.postCheckStatus).not.toHaveBeenCalled();
    });

    it('still posts for a rejected JOB-scoped security hold', async () => {
      // Its own call site posted the pending check when a context protection
      // rule held the job for security, and no delegate exists for a job-scoped
      // rejection — so this handler remains the only writer for it.
      const store = storeWithHold(HoldScope.enum.job, 'build (18)');
      const poster = makePoster();
      const onWorkflowReject = vi.fn().mockResolvedValue(true);

      await handleApprovalComment({
        ...createBaseParams({ commentBody: '/kici reject', heldRunStore: store }),
        resolvePoster: () => poster,
        onWorkflowReject,
      });

      expect(onWorkflowReject).not.toHaveBeenCalled();
      expect(poster.postCheckStatus).toHaveBeenCalledTimes(1);
      // Same conclusion the workflow-scoped rejection reaches — one user
      // action, one verdict.
      expect(poster.postCheckStatus.mock.calls[0][2]).toBe(CheckRunConclusion.enum.cancelled);
    });

    it('posts once when one command ends holds of both kinds', async () => {
      // The check is one named run per commit, so a mixed set still yields one
      // post — driven by the job-scoped hold, which really does have a pending
      // check, and not by the install gate beside it.
      const store = createMockHeldRunStore();
      store.listPendingSecurityHoldsForPr.mockResolvedValue([
        securityHoldRow({
          id: 'hold-install',
          run_id: 'run-1',
          job_id: installGateJobId('CI'),
          hold_scope: HoldScope.enum.workflow,
          approval_requirement: { clauses: [], expiresAt: 'x', reason: 'r' },
        }),
        securityHoldRow({ id: 'hold-job', run_id: 'run-2', job_id: 'build (18)' }),
      ]);
      const poster = makePoster();

      await handleApprovalComment({
        ...createBaseParams({ commentBody: '/kici reject', heldRunStore: store }),
        resolvePoster: () => poster,
      });

      expect(store.reject).toHaveBeenCalledTimes(2);
      expect(poster.postCheckStatus).toHaveBeenCalledTimes(1);
    });

    it('leaves the check pending while another hold on the same commit still owns it', async () => {
      // The check is shared. Ending one hold of a matrix that is still held
      // must NOT resolve it — as `success` that would let branch protection go
      // green over work nobody approved. The remaining hold's own ending is
      // what closes it.
      const store = createMockHeldRunStore();
      store.listPendingSecurityHoldsForPr.mockResolvedValue([securityHoldRow()]);
      const poster = makePoster();

      await handleApprovalComment({
        ...createBaseParams({
          heldRunStore: store,
          // A sibling job of the same run, still pending on the same commit.
          db: makeDb([securityHoldRow({ id: 'hold-sibling', job_id: 'build (20)' })]),
        }),
        resolvePoster: () => poster,
      });

      expect(store.approveByQueueType).toHaveBeenCalledTimes(1);
      expect(poster.postCheckStatus).not.toHaveBeenCalled();
    });

    it('settles an approved hold BEFORE resuming it', async () => {
      // A replayed dispatch can hold again and post its own pending status.
      // Settling afterwards would overwrite that pending status with `success`
      // and show a green security check over work that is held.
      const order: string[] = [];
      const store = createMockHeldRunStore();
      store.listPendingSecurityHoldsForPr.mockResolvedValue([securityHoldRow()]);
      const poster = {
        provider: 'github' as const,
        postCheckStatus: vi.fn().mockImplementation(async () => {
          order.push('settle');
        }),
        postWorkflowModificationCheck: vi.fn().mockResolvedValue(undefined),
      };

      await handleApprovalComment({
        ...createBaseParams({ heldRunStore: store }),
        resolvePoster: () => poster,
        onJobRelease: vi.fn().mockImplementation(async () => {
          order.push('resume');
        }),
      });

      expect(order).toEqual(['settle', 'resume']);
    });

    it('posts when the only other hold on the commit posted no check of its own', async () => {
      // The control for the case above: contention is decided by whether the
      // other hold OWNS the shared check, not by its mere presence. A
      // wait-timer hold posted none, so it cannot hold this check open.
      const store = createMockHeldRunStore();
      store.listPendingSecurityHoldsForPr.mockResolvedValue([securityHoldRow()]);
      const poster = makePoster();

      await handleApprovalComment({
        ...createBaseParams({
          heldRunStore: store,
          db: makeDb([
            securityHoldRow({
              id: 'hold-wait',
              job_id: 'slow',
              hold_type: HoldType.enum.timer,
              queue_type: 'context',
            }),
          ]),
        }),
        resolvePoster: () => poster,
      });

      expect(poster.postCheckStatus).toHaveBeenCalledTimes(1);
    });
  });

  // ── PR/repo scoping (the cross-tenant over-approval fix) ──────────────────

  it('scopes hold selection to the comment PR + repo and never lists org-wide', async () => {
    const store = createMockHeldRunStore();
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      { id: 'hold-pr42', run_id: 'run-pr42', queue_type: 'security', status: 'pending' },
    ]);

    const params = createBaseParams({
      heldRunStore: store,
      repoIdentifier: 'owner/repo',
      prNumber: 42,
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.listPendingSecurityHoldsForPr).toHaveBeenCalledWith('org-1', 'owner/repo', 42);
    // The org-wide list is the bug — it must never be reached.
    expect(store.listByQueueType).not.toHaveBeenCalled();
    expect(store.approveByQueueType).toHaveBeenCalledTimes(1);
    expect(store.approveByQueueType).toHaveBeenCalledWith(
      'org-1',
      'hold-pr42',
      'user-1',
      'security',
    );
  });

  it('approves only the runId within the PR scope; ignores other holds in the same PR', async () => {
    const store = createMockHeldRunStore();
    // The scoped query already returned only this PR's holds; runId narrows within.
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      { id: 'hold-a', run_id: 'run-a', queue_type: 'security', status: 'pending' },
      { id: 'hold-b', run_id: 'run-b', queue_type: 'security', status: 'pending' },
    ]);

    const params = createBaseParams({
      commentBody: '/kici approve run-a',
      heldRunStore: store,
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).toHaveBeenCalledTimes(1);
    expect(store.approveByQueueType).toHaveBeenCalledWith('org-1', 'hold-a', 'user-1', 'security');
  });

  it('explicit runId outside the PR scope matches nothing (no cross-PR bypass)', async () => {
    const store = createMockHeldRunStore();
    // Scoped query returns only PR #42's hold; a runId from another PR is absent.
    store.listPendingSecurityHoldsForPr.mockResolvedValue([
      { id: 'hold-pr42', run_id: 'run-pr42', queue_type: 'security', status: 'pending' },
    ]);

    const params = createBaseParams({
      commentBody: '/kici approve run-from-another-pr',
      heldRunStore: store,
      prNumber: 42,
    });
    const result = await handleApprovalComment(params);

    expect(result.handled).toBe(true);
    expect(store.approveByQueueType).not.toHaveBeenCalled();
    expect(store.reject).not.toHaveBeenCalled();
  });
});
