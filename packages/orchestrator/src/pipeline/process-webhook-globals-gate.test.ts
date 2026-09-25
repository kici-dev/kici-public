/**
 * Org global-workflow dispatch honours the event's trust-policy verdict.
 *
 * The trust policy is a property of the EVENT, so it applies to the
 * organization's global workflows exactly as it applies to the pull request's
 * own: with `forkPolicy: 'hold'` a fork PR must not execute a global workflow
 * against its head SHA with ORG credentials. Each global run is held in the
 * security queue next to the pull request's own runs, and carries the security
 * check a held run posts.
 *
 * Two paths, tested independently because they have diverged before:
 *
 * - `tryDispatchGlobalsWithoutLockFile` (no-lock-file branch), which must see
 *   the verdict even though no per-repository workflow is dispatched.
 * - `dispatchGlobalWorkflowsForOtherRepos` (a lock file resolved).
 *
 * Both are driven end-to-end through `processWebhook`, because the no-lock-file
 * case depends on the call ORDER in the caller.
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatchGlobalWorkflowsForOtherRepos, processWebhook } from './process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';
import {
  HoldScope,
  InitFailureCategory,
  SECURITY_HOLD_JOB_IDS,
  TriggerSource,
  type TrustPolicy,
} from '@kici-dev/engine';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import { ROUND_JOB_PREFIX } from './global-eval-round.js';
import { webhookPayloadPath } from './webhook-payload-store.js';

const ORG = '__default__';
const SOURCE_REPO = 'acme/app';
const GLOBAL_REPO = 'acme/org-workflows';

function makeInfo(): WebhookInfo {
  return {
    routingKey: 'github:1',
    deliveryId: `d-${Math.random().toString(36).slice(2)}`,
    event: 'pull_request',
    action: 'opened',
    provider: 'github',
    payload: { repository: { full_name: SOURCE_REPO } },
  } as unknown as WebhookInfo;
}

/** A global workflow in ANOTHER repo that triggers on pull_request. */
function makeGlobalRegistration(
  over: { name?: string; id?: string; hasFilter?: boolean; jobs?: unknown[] } = {},
) {
  return {
    id: over.id ?? 'reg-global-1',
    routingKey: 'github:1',
    repoIdentifier: GLOBAL_REPO,
    commitSha: 'globalsha',
    defaultBranch: 'trunk',
    sourceFile: '.kici/workflows/org.ts',
    lockEntry: {
      name: over.name ?? 'org-guard',
      ...(over.hasFilter === undefined ? {} : { hasFilter: over.hasFilter }),
      contentHash: 'ghash',
      compileSchemaVersion: 1,
      // `_type: 'pr'` is the lock-file spelling; `pull_request` is the wire
      // event name that `eventTypeToTriggerType` maps onto it.
      triggers: [
        { _type: 'pr', events: ['opened'], targetBranches: [], sourceBranches: [], paths: [] },
      ],
      jobs: over.jobs ?? [
        {
          _type: 'static',
          name: 'scan',
          // Label matchers are objects, not bare strings — `partitionMatchers`
          // rejects a raw string as a stale lock file.
          runsOn: [{ kind: 'exact', value: 'default' }],
          needs: [],
          steps: [{ name: 'scan', hasOutputs: false }],
        },
      ],
    },
  };
}

/**
 * Deps that reach the no-lock-file globals branch: the bundle has no
 * `lockFileFetcher`, so the lock file never resolves and `processWebhook` takes
 * the Phase F branch.
 */
function makeDeps(
  policy: TrustPolicy,
  over: {
    withLockFile?: boolean;
    unconfigured?: boolean;
    /** The registered globals; defaults to one static-only workflow. */
    registrations?: ReturnType<typeof makeGlobalRegistration>[];
  } = {},
): {
  deps: Parameters<typeof processWebhook>[1];
  bundle: Record<string, unknown>;
  dispatch: ReturnType<typeof vi.fn>;
  postCheckStatus: ReturnType<typeof vi.fn>;
  recordEventLog: ReturnType<typeof vi.fn>;
  recordRunHeld: ReturnType<typeof vi.fn>;
  recordInitFailureRun: ReturnType<typeof vi.fn>;
  createHold: ReturnType<typeof vi.fn>;
  /** The pending-eval tracker every round attempt registers with. */
  track: ReturnType<typeof vi.fn>;
  /** Object-storage writes — how a held round keeps its webhook payload. */
  append: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn().mockResolvedValue({ status: 'queued', jobId: 'job-1' });
  const postCheckStatus = vi.fn().mockResolvedValue(undefined);
  const recordEventLog = vi.fn().mockResolvedValue(undefined);
  const recordRunHeld = vi.fn().mockResolvedValue(undefined);
  const recordInitFailureRun = vi.fn().mockResolvedValue(undefined);
  const createHold = vi.fn(async () => ({ id: 'hold-1' }));
  // A filter candidate that clears the round, so a passing event dispatches its job.
  const track = vi.fn(async () => ({
    candidates: [{ workflowName: 'org-filtered', run: true, jobs: [] }],
  }));
  const append = vi.fn(async () => undefined);

  const bundle = {
    normalizer: {
      provider: 'github',
      normalizeEvent: () => ({
        type: 'pull_request',
        action: 'opened',
        payload: {},
        targetBranch: 'main',
        baseBranch: undefined,
        sourceBranch: 'feature',
        senderUsername: 'octocat',
        // The fork is what makes this event interesting to the policy.
        isForkPR: true,
        provider: 'github',
      }),
      extractRef: () => 'headsha',
      extractRepoIdentifier: () => SOURCE_REPO,
      extractCredentials: () => ({ token: 'src-token' }),
      isDefaultBranchPush: () => false,
    },
    // Present so `evaluateSecurityPolicy` does not short-circuit to `pass`:
    // the policy only applies to providers with a fork model.
    hasForkModel: true,
    checkStatusPoster: { provider: 'github', postCheckStatus },
    // Deliberately absent: no lock file resolves, so Phase F runs.
    lockFileFetcher: over.withLockFile ? { fetchLockFile: vi.fn() } : undefined,
    repoUrlBuilder: { buildCloneUrl: () => 'https://example.invalid/repo.git' },
  };

  const deps = {
    dedup: { claim: vi.fn(async () => true), exists: vi.fn(), mark: vi.fn(), cleanup: vi.fn() },
    providerRegistry: { getByRoutingKey: () => bundle, getAll: () => [] },
    orchestratorMode: 'platform',
    trustPolicyStore: {
      get: vi.fn(async () =>
        over.unconfigured
          ? null
          : {
              ...policy,
              source: 'platform',
              updatedAt: new Date(),
            },
      ),
    },
    // Present so the skip branches actually write their row: `recordSkipEventLog`
    // returns early without it, and the drop's row is the only trace it leaves.
    eventLog: { record: recordEventLog },
    registrationIndex: {
      refreshIfNeeded: vi.fn(async () => undefined),
      getGlobalByOrgAndTriggerType: () => over.registrations ?? [makeGlobalRegistration()],
      getByRepo: () => [],
      getByOrgAndEvent: () => [],
    },
    dispatcher: { dispatch },
    pendingGlobalEvals: { track, cleanup: vi.fn() },
    logStorage: { append },
    executionTracker: {
      recordRunHeld,
      recordInitFailureRun,
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      onJobStatus: vi.fn().mockResolvedValue(undefined),
      holdRunForPendingJobs: vi.fn().mockReturnValue(true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    },
    heldRunStore: {
      create: createHold,
      markPendingCheckPosted: vi.fn().mockResolvedValue(undefined),
    },
    // With a lock file present the flow reaches Phase J
    // (`dispatchGlobalWorkflowsForOtherRepos`) instead of Phase F. The
    // same-source lock deliberately declares only a `push` workflow, which
    // cannot match this pull_request event — so any dispatch observed in that
    // case came from the ORG GLOBAL path, which is the guard under test.
    lockFileCache: {
      get: vi.fn(async () =>
        over.withLockFile
          ? {
              schemaVersion: 9,
              source: { file: '.kici/workflows/ci.ts', export: '#default' },
              contentHash: 'srchash',
              workflows: [
                {
                  name: 'src-push-only',
                  contentHash: 'shash',
                  compileSchemaVersion: 1,
                  triggers: [{ _type: 'push', branches: [], paths: [] }],
                  jobs: [],
                },
              ],
            }
          : null,
      ),
    },
  } as unknown as Parameters<typeof processWebhook>[1];

  return {
    deps,
    bundle,
    dispatch,
    postCheckStatus,
    recordEventLog,
    recordRunHeld,
    recordInitFailureRun,
    createHold,
    track,
    append,
  };
}

const HOLD_ALL: TrustPolicy = {
  forkPolicy: 'hold',
  approvalExpiryHours: 72,
};

describe('global-workflow dispatch honours the event trust decision', () => {
  it('reaches the policy on the no-lock-file path, which used to return first', async () => {
    // The blocker's direct regression test. Before the fix, Phase F returned
    // before `evaluateSecurityPolicy` ran, so the store was never even read.
    const { deps, dispatch } = makeDeps({ ...HOLD_ALL, forkPolicy: 'hold' });

    await processWebhook(makeInfo(), deps);

    expect(deps.trustPolicyStore!.get).toHaveBeenCalledWith(ORG);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('holds the global run when the policy holds the event', async () => {
    // fails-when: a held event dispatches the global run, or drops it without a held run
    const { deps, dispatch, recordRunHeld, createHold } = makeDeps({
      ...HOLD_ALL,
      forkPolicy: 'hold',
    });

    await processWebhook(makeInfo(), deps);

    expect(dispatch).not.toHaveBeenCalled();
    expect(recordRunHeld).toHaveBeenCalledTimes(1);
    expect(recordRunHeld.mock.calls[0][0]).toMatchObject({
      workflowName: 'org-guard',
      repoIdentifier: SOURCE_REPO,
      workflowRepoIdentifier: GLOBAL_REPO,
      workflowSha: 'globalsha',
      reason: SecurityHoldReason.enum.fork_pr,
    });
    // The hold row is what the security queue lists and an approval releases.
    expect(createHold).toHaveBeenCalledTimes(1);
  });

  it('still dispatches global workflows when the policy passes', async () => {
    // The non-vacuity control: with the fork explicitly allowed the SAME
    // fixture dispatches, so the assertions above are about the policy
    // and not about a harness that never dispatches anything.
    const { deps, dispatch } = makeDeps({ ...HOLD_ALL, forkPolicy: 'allow' });

    await processWebhook(makeInfo(), deps);

    expect(dispatch).toHaveBeenCalled();
  });

  // ── Phase J: the OTHER global-dispatch path, guarded independently ────────
  // `dispatchGlobalWorkflowsForOtherRepos` runs when a lock file DOES resolve.
  // It failed for a different reason than Phase F — it received the decision's
  // siblings but never the decision — so it needs its own falsifiable coverage.

  it('holds the cross-repo global run when the policy holds (lock-file path)', async () => {
    // fails-when: the lock-file path dispatches or drops a held global run
    const { deps, dispatch, recordRunHeld } = makeDeps(
      { ...HOLD_ALL, forkPolicy: 'hold' },
      { withLockFile: true },
    );

    await processWebhook(makeInfo(), deps);

    expect(dispatch).not.toHaveBeenCalled();
    expect(recordRunHeld).toHaveBeenCalledTimes(1);
    expect(recordRunHeld.mock.calls[0][0]).toMatchObject({
      repoIdentifier: SOURCE_REPO,
      workflowRepoIdentifier: GLOBAL_REPO,
    });
  });

  it('records a failed global run when the verdict rejects the event', async () => {
    // fails-when: a rejected event dispatches the global run or records nothing
    const { deps, bundle, dispatch, recordInitFailureRun } = makeDeps({
      ...HOLD_ALL,
      forkPolicy: 'allow',
    });
    const event = (
      bundle.normalizer as { normalizeEvent: () => Record<string, unknown> }
    ).normalizeEvent();

    await dispatchGlobalWorkflowsForOtherRepos({
      info: makeInfo(),
      deps,
      eventWithFiles: { ...event, sourceRepo: SOURCE_REPO },
      resolvedOrgId: ORG,
      repoIdentifier: SOURCE_REPO,
      ref: 'headsha',
      dispatchBundle: bundle,
      dispatchCredentials: { token: 'src-token' },
      bundle,
      credentials: { token: 'src-token' },
      trustResolution: undefined,
      securityDecision: {
        action: 'reject',
        reason: SecurityHoldReason.enum.fork_pr,
        message: 'fork PRs are rejected',
      },
    } as unknown as Parameters<typeof dispatchGlobalWorkflowsForOtherRepos>[0]);

    expect(dispatch).not.toHaveBeenCalled();
    expect(recordInitFailureRun).toHaveBeenCalledTimes(1);
    expect(recordInitFailureRun.mock.calls[0][0]).toMatchObject({
      repoIdentifier: SOURCE_REPO,
      workflowRepoIdentifier: GLOBAL_REPO,
      initFailure: { category: InitFailureCategory.enum.trust_policy },
    });
  });

  it('still dispatches cross-repo global workflows when the policy passes (lock-file path)', async () => {
    // Non-vacuity control for the case above: the same fixture with forks
    // allowed does dispatch, and the only workflow that can match this event is
    // the org global one (the source lock declares a push-only workflow).
    const { deps, dispatch } = makeDeps(
      { ...HOLD_ALL, forkPolicy: 'allow' },
      { withLockFile: true },
    );

    await processWebhook(makeInfo(), deps);

    expect(dispatch).toHaveBeenCalled();
  });

  it('posts the security check of the held run and no organization-workflows notice', async () => {
    // fails-when: the held global run leaves no pending check on the commit
    // breaks-if-wrong: the pending check must go through the security check,
    //   which approve / reject later complete
    const { deps, bundle, postCheckStatus } = makeDeps({ ...HOLD_ALL, forkPolicy: 'hold' });

    await processWebhook(makeInfo(), deps);

    expect(postCheckStatus).toHaveBeenCalledWith(
      SOURCE_REPO,
      'headsha',
      'pending',
      'Held for approval',
      expect.any(String),
      expect.anything(),
    );
    // The poster offers no skipped-notice method, so nothing can post one.
    expect(Object.keys(bundle.checkStatusPoster as object)).toEqual([
      'provider',
      'postCheckStatus',
    ]);
  });

  it('posts NO check at all when the fork policy ignores the event', async () => {
    // The point of `ignore`: the event leaves no trace a contributor can see.
    // A held global run and its pending check would be exactly such a trace, so
    // this is the one non-passing verdict that must post nothing — the case
    // above proves the same fixture does post under `hold`, so this is not
    // vacuous.
    const { deps, dispatch, postCheckStatus, recordRunHeld } = makeDeps({
      ...HOLD_ALL,
      forkPolicy: 'ignore',
    });

    await processWebhook(makeInfo(), deps);

    expect(dispatch).not.toHaveBeenCalled();
    expect(recordRunHeld).not.toHaveBeenCalled();
    expect(postCheckStatus).not.toHaveBeenCalled();
  });

  it('records WHY the ignored event was dropped, and where the policy came from', async () => {
    // The event-log row is the only surface that can explain this drop: there
    // is no run, no check, and nothing on the pull request. A bare `received`
    // row reads identically to an unknown-provider or unknown-event skip, which
    // is what left a maintainer with a fork PR and no explanation anywhere.
    const stored = makeDeps({ ...HOLD_ALL, forkPolicy: 'ignore' });
    const unconfigured = makeDeps({ ...HOLD_ALL, forkPolicy: 'ignore' }, { unconfigured: true });

    await processWebhook(makeInfo(), stored.deps);
    await processWebhook(makeInfo(), unconfigured.deps);

    const messageOf = (fn: ReturnType<typeof vi.fn>) =>
      (fn.mock.calls.at(-1)![2] as { errorMessage?: string }).errorMessage ?? '';

    const storedMessage = messageOf(stored.recordEventLog);
    const unconfiguredMessage = messageOf(unconfigured.recordEventLog);

    expect(storedMessage).toContain('forkPolicy=ignore');
    expect(storedMessage).toContain('visible to the contributor');

    // An org that never chose `ignore` needs a different next step from one
    // that did, and the two produce the SAME verdict — so the row has to carry
    // the difference or nothing can.
    expect(unconfiguredMessage).not.toBe(storedMessage);
    expect(unconfiguredMessage).toContain('no stored trust policy');

    // Non-vacuity: the identical fixture writes NO message on a verdict that
    // leaves other traces behind, so a build that stamped the same text on
    // every skip would fail here.
    const held = makeDeps({ ...HOLD_ALL, forkPolicy: 'hold' });
    await processWebhook(makeInfo(), held.deps);
    expect(messageOf(held.recordEventLog)).toBe('');
  });

  it('drops the ignored event before it reads a lock file', async () => {
    // The drop has to precede the lock-file fetch: every run row, check status,
    // and clone token in this pipeline is created at or after it. Driven with
    // `withLockFile: true` so the cache read is the observable proxy for that
    // fetch — the same fixture reads it on every other verdict.
    const ignored = makeDeps({ ...HOLD_ALL, forkPolicy: 'ignore' }, { withLockFile: true });
    const held = makeDeps({ ...HOLD_ALL, forkPolicy: 'hold' }, { withLockFile: true });
    const lockRead = (d: typeof ignored.deps) =>
      (d as unknown as { lockFileCache: { get: ReturnType<typeof vi.fn> } }).lockFileCache.get;

    const outcome = await processWebhook(makeInfo(), ignored.deps);
    await processWebhook(makeInfo(), held.deps);

    expect(outcome).toBe('skipped');
    expect(lockRead(ignored.deps)).not.toHaveBeenCalled();
    // Non-vacuity: the identical fixture DOES read the lock file when the
    // verdict is one that lets the event continue.
    expect(lockRead(held.deps)).toHaveBeenCalled();
    // …and the policy really was consulted, so the drop is a decision and not a
    // fixture that never got started.
    expect(
      (ignored.deps as unknown as { trustPolicyStore: { get: ReturnType<typeof vi.fn> } })
        .trustPolicyStore.get,
    ).toHaveBeenCalledWith(ORG);
  });
});

/**
 * A global candidate that needs the pre-run evaluation round runs the workflow
 * repository's filter or generator on an agent that has the event's head checked
 * out. A held event must not run that code before a human approves it, exactly
 * as a held per-repository workflow evaluates its filter only after release.
 */
describe('the pre-run evaluation round of a held event', () => {
  const FILTERED = 'org-filtered';
  const ROUND_NAME = `${ROUND_JOB_PREFIX}${GLOBAL_REPO}`;

  function filteredAndImmediate() {
    return [
      makeGlobalRegistration({ name: FILTERED, id: 'reg-filtered', hasFilter: true }),
      makeGlobalRegistration(),
    ];
  }

  function passArgs(
    h: ReturnType<typeof makeDeps>,
    securityDecision: Record<string, unknown>,
  ): Parameters<typeof dispatchGlobalWorkflowsForOtherRepos>[0] {
    const event = (
      h.bundle.normalizer as { normalizeEvent: () => Record<string, unknown> }
    ).normalizeEvent();
    return {
      info: makeInfo(),
      deps: h.deps,
      eventWithFiles: { ...event, sourceRepo: SOURCE_REPO, prNumber: 7 },
      resolvedOrgId: ORG,
      repoIdentifier: SOURCE_REPO,
      ref: 'headsha',
      dispatchBundle: h.bundle,
      dispatchCredentials: { token: 'src-token' },
      bundle: h.bundle,
      credentials: { token: 'src-token' },
      trustResolution: undefined,
      securityDecision,
    } as unknown as Parameters<typeof dispatchGlobalWorkflowsForOtherRepos>[0];
  }

  const HOLD = {
    action: 'hold',
    reason: SecurityHoldReason.enum.fork_pr,
    message: 'fork PRs need approval',
    approvalExpirySeconds: null,
  };

  it('dispatches no round and records one held round run carrying its workflow provenance', async () => {
    // fails-when: a held event dispatches the round job, or holds nothing for it
    const h = makeDeps(HOLD_ALL, { registrations: filteredAndImmediate() });

    const outcome = await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, HOLD));

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
    const held = h.recordRunHeld.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const round = held.find((row) => row.workflowName === ROUND_NAME);
    expect(round).toMatchObject({
      repoIdentifier: SOURCE_REPO,
      workflowRepoIdentifier: GLOBAL_REPO,
      workflowSha: 'globalsha',
      workflowBranch: 'trunk',
      sha: 'headsha',
      prNumber: 7,
      isGlobalEvalRound: true,
      reason: SecurityHoldReason.enum.fork_pr,
      // fails-when: the hold records no covered set, so a release cannot tell a dropped workflow
      heldRoundWorkflows: [FILTERED],
    });
    // The immediate candidate of the same event is held by the pipeline, as before.
    expect(held.map((row) => row.workflowName).sort()).toEqual(['org-guard', ROUND_NAME].sort());
    // One security-queue row per held run, of the shape the release route expects.
    expect(h.createHold).toHaveBeenCalledTimes(2);
    const roundHold = h.createHold.mock.calls
      .map((c) => (c as unknown[])[1] as Record<string, unknown>)
      .find((row) => row.runId === round!.runId);
    expect(roundHold).toMatchObject({
      scope: HoldScope.enum.workflow,
      triggerSource: TriggerSource.enum.context,
      jobId: SECURITY_HOLD_JOB_IDS[SecurityHoldReason.enum.fork_pr],
    });
    // The release replays the event from this payload.
    expect(h.append).toHaveBeenCalledWith(
      webhookPayloadPath(String(round!.runId)),
      expect.any(String),
    );
    expect(outcome.matchedRunIds).toContain(round!.runId);
  });

  it('holds one round per workflow repository, however many of its workflows need it', async () => {
    const h = makeDeps(HOLD_ALL, {
      registrations: [
        makeGlobalRegistration({ name: FILTERED, id: 'reg-a', hasFilter: true }),
        makeGlobalRegistration({ name: 'org-filtered-2', id: 'reg-b', hasFilter: true }),
      ],
    });

    await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, HOLD));

    const rounds = h.recordRunHeld.mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>).workflowName === ROUND_NAME,
    );
    expect(rounds).toHaveLength(1);
  });

  it('dispatches the round exactly as before when the event passes', async () => {
    // The control: the same fixture runs the round and dispatches what it admits,
    // so the empty dispatcher above is about the hold.
    const h = makeDeps(HOLD_ALL, { registrations: filteredAndImmediate() });

    await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, { action: 'pass' }));

    const names = h.dispatch.mock.calls.map((c) =>
      String((c[0] as Record<string, unknown>).jobName),
    );
    expect(names.some((name) => name.startsWith(ROUND_JOB_PREFIX))).toBe(true);
    expect(h.track).toHaveBeenCalledTimes(1);
    expect(
      h.recordRunHeld.mock.calls.filter(
        (c) => (c[0] as Record<string, unknown>).workflowName === ROUND_NAME,
      ),
    ).toEqual([]);
  });

  it('records a round candidate of a rejected event as the pipeline records a rejected workflow', async () => {
    // fails-when: a rejected event still runs the round, or records nothing for its candidates
    const h = makeDeps(HOLD_ALL, { registrations: filteredAndImmediate() });

    await dispatchGlobalWorkflowsForOtherRepos(
      passArgs(h, {
        action: 'reject',
        reason: SecurityHoldReason.enum.fork_pr,
        message: 'fork PRs are rejected',
      }),
    );

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
    const rejected = h.recordInitFailureRun.mock.calls.map(
      (c) => c[0] as { workflowName: string; initFailure: { category: string } },
    );
    expect(rejected.map((row) => row.workflowName).sort()).toEqual([FILTERED, 'org-guard'].sort());
    for (const row of rejected) {
      expect(row.initFailure.category).toBe(InitFailureCategory.enum.trust_policy);
    }
  });

  it('records a rejected run for a generator-only candidate, which has no static job', async () => {
    // breaks-if-wrong: a candidate whose every job a DynamicJobFn produces must
    // still leave the rejected run a per-repository workflow would
    const h = makeDeps(HOLD_ALL, {
      registrations: [
        makeGlobalRegistration({
          name: 'org-generated',
          id: 'reg-generated',
          jobs: [{ _type: 'dynamic', source: { file: '.kici/workflows/org.ts', index: 0 } }],
        }),
      ],
    });

    await dispatchGlobalWorkflowsForOtherRepos(
      passArgs(h, {
        action: 'reject',
        reason: SecurityHoldReason.enum.fork_pr,
        message: 'fork PRs are rejected',
      }),
    );

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.recordInitFailureRun.mock.calls.map((c) => c[0].workflowName)).toEqual([
      'org-generated',
    ]);
  });

  it('records nothing and runs no round for an ignored event', async () => {
    const h = makeDeps(HOLD_ALL, { registrations: filteredAndImmediate() });

    await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, { action: 'ignore' }));

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.track).not.toHaveBeenCalled();
    expect(h.recordRunHeld).not.toHaveBeenCalled();
    expect(h.recordInitFailureRun).not.toHaveBeenCalled();
  });

  it('reports a workflow repository with held candidates as not decided', async () => {
    // A re-run of a failed round posts its success check only for a decided
    // repository; a held event decided nothing about the workflows it holds.
    // fails-when: a held event counts its workflow repository as decided
    const h = makeDeps(HOLD_ALL, { registrations: filteredAndImmediate() });

    const outcome = await dispatchGlobalWorkflowsForOtherRepos({
      ...passArgs(h, HOLD),
      onlyWorkflowRepo: GLOBAL_REPO,
    });

    expect(outcome.decidedWorkflowRepos).toEqual([]);
  });
});
