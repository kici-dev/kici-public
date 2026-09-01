/**
 * Org global-workflow dispatch honours the event's trust-policy verdict.
 *
 * This is the regression suite for the defect that parked this feature through
 * nine reviews: the trust policy gated the pull request's OWN workflows, but
 * both org-global dispatch paths ran regardless. With `forkPolicy: 'reject'` a
 * fork PR still executed the organization's global workflows against its head
 * SHA with ORG credentials — the same false assurance the feature exists to
 * remove.
 *
 * Two paths, tested independently because they fail for different reasons:
 *
 * - `tryDispatchGlobalsWithoutLockFile` (no-lock-file branch) returned BEFORE
 *   the policy was evaluated at all, so no amount of threading would have
 *   fixed it — the evaluation had to move ahead of the branch.
 * - `dispatchGlobalWorkflowsForOtherRepos` received the decision's siblings but
 *   never the decision.
 *
 * Both are module-private, so they are driven end-to-end through
 * `processWebhook` rather than called directly: a test that reached in and
 * called the helper would not have caught the no-lock-file case, whose whole
 * bug was the call ORDER in the caller.
 */
import { describe, it, expect, vi } from 'vitest';
import { processWebhook } from './process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { TrustPolicy } from '@kici-dev/engine';

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
function makeGlobalRegistration() {
  return {
    id: 'reg-global-1',
    routingKey: 'github:1',
    repoIdentifier: GLOBAL_REPO,
    commitSha: 'globalsha',
    sourceFile: '.kici/workflows/org.ts',
    lockEntry: {
      name: 'org-guard',
      contentHash: 'ghash',
      compileSchemaVersion: 1,
      // `_type: 'pr'` is the lock-file spelling; `pull_request` is the wire
      // event name that `eventTypeToTriggerType` maps onto it.
      triggers: [
        { _type: 'pr', events: ['opened'], targetBranches: [], sourceBranches: [], paths: [] },
      ],
      jobs: [
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
  over: { withLockFile?: boolean } = {},
): {
  deps: Parameters<typeof processWebhook>[1];
  dispatch: ReturnType<typeof vi.fn>;
  postCheckStatus: ReturnType<typeof vi.fn>;
  postGlobalWorkflowsSkippedCheck: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn().mockResolvedValue({ status: 'queued' });
  const postCheckStatus = vi.fn().mockResolvedValue(undefined);
  const postGlobalWorkflowsSkippedCheck = vi.fn().mockResolvedValue(undefined);

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
    checkStatusPoster: { provider: 'github', postCheckStatus, postGlobalWorkflowsSkippedCheck },
    // Deliberately absent: no lock file resolves, so Phase F runs.
    lockFileFetcher: over.withLockFile ? { fetchLockFile: vi.fn() } : undefined,
    repoUrlBuilder: { buildCloneUrl: () => 'https://example.invalid/repo.git' },
  };

  const deps = {
    dedup: { claim: vi.fn(async () => true), exists: vi.fn(), mark: vi.fn(), cleanup: vi.fn() },
    providerRegistry: { getByRoutingKey: () => bundle, getAll: () => [] },
    orchestratorMode: 'platform',
    trustPolicyStore: {
      get: vi.fn(async () => ({
        ...policy,
        source: 'platform',
        updatedAt: new Date(),
      })),
    },
    registrationIndex: {
      refreshIfNeeded: vi.fn(async () => undefined),
      getGlobalByOrgAndTriggerType: () => [makeGlobalRegistration()],
      getByRepo: () => [],
      getByOrgAndEvent: () => [],
    },
    dispatcher: { dispatch },
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

  return { deps, dispatch, postCheckStatus, postGlobalWorkflowsSkippedCheck };
}

const HOLD_ALL: TrustPolicy = {
  forkPolicy: 'hold',
  unknownContributorPolicy: 'hold',
  workflowChangePolicy: 'hold',
  approvalExpiryHours: 72,
};

describe('global-workflow dispatch honours the event trust decision', () => {
  it('reaches the policy on the no-lock-file path, which used to return first', async () => {
    // The blocker's direct regression test. Before the fix, Phase F returned
    // before `evaluateSecurityPolicy` ran, so the store was never even read.
    const { deps, dispatch } = makeDeps({ ...HOLD_ALL, forkPolicy: 'reject' });

    await processWebhook(makeInfo(), deps);

    expect(deps.trustPolicyStore!.get).toHaveBeenCalledWith(ORG);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches no global workflow when the policy rejects the event', async () => {
    const { deps, dispatch } = makeDeps({ ...HOLD_ALL, forkPolicy: 'reject' });

    await processWebhook(makeInfo(), deps);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches no global workflow when the policy holds the event', async () => {
    const { deps, dispatch } = makeDeps({ ...HOLD_ALL, forkPolicy: 'hold' });

    await processWebhook(makeInfo(), deps);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('still dispatches global workflows when the policy passes', async () => {
    // The non-vacuity control: with the fork explicitly allowed the SAME
    // fixture dispatches, so the three assertions above are about the policy
    // and not about a harness that never dispatches anything.
    const { deps, dispatch } = makeDeps({
      ...HOLD_ALL,
      forkPolicy: 'allow',
      unknownContributorPolicy: 'hold',
    });

    await processWebhook(makeInfo(), deps);

    expect(dispatch).toHaveBeenCalled();
  });

  // ── Phase J: the OTHER global-dispatch path, guarded independently ────────
  // `dispatchGlobalWorkflowsForOtherRepos` runs when a lock file DOES resolve.
  // It failed for a different reason than Phase F — it received the decision's
  // siblings but never the decision — so it needs its own falsifiable coverage.

  it('dispatches no cross-repo global workflow when the policy rejects (lock-file path)', async () => {
    const { deps, dispatch } = makeDeps(
      { ...HOLD_ALL, forkPolicy: 'reject' },
      { withLockFile: true },
    );

    await processWebhook(makeInfo(), deps);

    expect(dispatch).not.toHaveBeenCalled();
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

  it('posts the skipped notice on its own check, never through the security check', async () => {
    // `postCheckStatus` writes ONE named check run per commit ("KiCI Security"),
    // which the hold posts as pending and approve / reject later complete.
    // Routing this notice through it would UPDATE that run to a completed
    // neutral conclusion while the run is still held — resolving the check a
    // branch protection rule waits on. So the notice has its own poster method
    // and its own check name, exactly like the workflow-modification check.
    const { deps, postCheckStatus, postGlobalWorkflowsSkippedCheck } = makeDeps({
      ...HOLD_ALL,
      forkPolicy: 'hold',
    });

    await processWebhook(makeInfo(), deps);

    expect(postGlobalWorkflowsSkippedCheck).toHaveBeenCalledTimes(1);
    expect(postGlobalWorkflowsSkippedCheck.mock.calls[0][2]).toContain(
      'organization-wide global workflows did not run',
    );
    // Nothing was written to the security check by this path — neither a second
    // failure (which would double-report one decision) nor a neutral one.
    expect(postCheckStatus).not.toHaveBeenCalled();
  });

  it('posts NO check at all when the fork policy ignores the event', async () => {
    // The point of `ignore`: the event leaves no trace a contributor can see.
    // A skipped-globals notice would be exactly such a trace, so this is the
    // one non-passing verdict that must post nothing — the case above proves
    // the same fixture does post under `hold`, so this is not vacuous.
    const { deps, dispatch, postCheckStatus, postGlobalWorkflowsSkippedCheck } = makeDeps({
      ...HOLD_ALL,
      forkPolicy: 'ignore',
    });

    await processWebhook(makeInfo(), deps);

    expect(dispatch).not.toHaveBeenCalled();
    expect(postGlobalWorkflowsSkippedCheck).not.toHaveBeenCalled();
    expect(postCheckStatus).not.toHaveBeenCalled();
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
