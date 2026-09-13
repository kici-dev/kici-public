/**
 * A cross-repo global workflow run stores the webhook payload that triggered it.
 *
 * The per-repository dispatch path persists `info.payload` to
 * `executions/<runId>/webhook-payload.json` (`dispatch-matched-workflow.ts`,
 * `setupDispatchContext`), which is what the dashboard's Payload tab reads and
 * what a re-run copies onto the new run. Both global-dispatch paths build their
 * `QueuedJobInput`s directly and never reach that helper, so a global run had a
 * Payload tab that could only ever fail to load — the event the workflow reacted
 * to, which for a global workflow comes from a repo the author may not even own,
 * was the one thing the run could not show.
 *
 * Both global paths are covered because they are separate call sites:
 * `tryDispatchGlobalsWithoutLockFile` (Phase F, no lock file resolves) and
 * `dispatchGlobalWorkflowsForOtherRepos` (Phase J, a lock file resolved).
 * The fixture shape mirrors `process-webhook-globals-gate.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { processWebhook } from './process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';
import { webhookPayloadPath } from './webhook-payload-store.js';

const SOURCE_REPO = 'acme/app';
const GLOBAL_REPO = 'acme/org-workflows';

/** The inbound payload — the exact bytes the run must be able to show. */
const PAYLOAD = { repository: { full_name: SOURCE_REPO }, number: 42 };

function makeInfo(): WebhookInfo {
  return {
    routingKey: 'github:1',
    deliveryId: `d-${Math.random().toString(36).slice(2)}`,
    event: 'pull_request',
    action: 'opened',
    provider: 'github',
    payload: PAYLOAD,
  } as unknown as WebhookInfo;
}

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
      triggers: [
        { _type: 'pr', events: ['opened'], targetBranches: [], sourceBranches: [], paths: [] },
      ],
      jobs: [
        {
          _type: 'static',
          name: 'scan',
          runsOn: [{ kind: 'exact', value: 'default' }],
          needs: [],
          steps: [{ name: 'scan', hasOutputs: false }],
        },
      ],
    },
  };
}

function makeDeps(over: { withLockFile?: boolean; logStorage?: boolean } = {}): {
  deps: Parameters<typeof processWebhook>[1];
  dispatch: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn().mockResolvedValue({ status: 'queued' });
  const append = vi.fn().mockResolvedValue(undefined);

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
        isForkPR: false,
        provider: 'github',
      }),
      extractRef: () => 'headsha',
      extractRepoIdentifier: () => SOURCE_REPO,
      extractCredentials: () => ({ token: 'src-token' }),
      isDefaultBranchPush: () => false,
    },
    checkStatusPoster: {
      provider: 'github',
      postCheckStatus: vi.fn().mockResolvedValue(undefined),
      postGlobalWorkflowsSkippedCheck: vi.fn().mockResolvedValue(undefined),
    },
    lockFileFetcher: over.withLockFile ? { fetchLockFile: vi.fn() } : undefined,
    repoUrlBuilder: { buildCloneUrl: () => 'https://example.invalid/repo.git' },
  };

  const deps = {
    dedup: { claim: vi.fn(async () => true), exists: vi.fn(), mark: vi.fn(), cleanup: vi.fn() },
    providerRegistry: { getByRoutingKey: () => bundle, getAll: () => [] },
    orchestratorMode: 'platform',
    registrationIndex: {
      refreshIfNeeded: vi.fn(async () => undefined),
      getGlobalByOrgAndTriggerType: () => [makeGlobalRegistration()],
      getByRepo: () => [],
      getByOrgAndEvent: () => [],
    },
    dispatcher: { dispatch },
    // Absent when `logStorage: false` — the orchestrator runs without object
    // storage configured, and the dispatch must still succeed.
    ...(over.logStorage === false ? {} : { logStorage: { append } }),
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

  return { deps, dispatch, append };
}

/** The run id the global candidate dispatched under. */
function dispatchedRunId(dispatch: ReturnType<typeof vi.fn>): string {
  expect(dispatch).toHaveBeenCalled();
  return dispatch.mock.calls[0][0].runId as string;
}

describe('a global workflow run stores its triggering webhook payload', () => {
  it('stores the payload under the global run id on the no-lock-file path', async () => {
    const { deps, dispatch, append } = makeDeps();

    await processWebhook(makeInfo(), deps);

    const runId = dispatchedRunId(dispatch);
    expect(append).toHaveBeenCalledWith(webhookPayloadPath(runId), JSON.stringify(PAYLOAD));
  });

  it('stores the payload under the global run id on the lock-file path', async () => {
    const { deps, dispatch, append } = makeDeps({ withLockFile: true });

    await processWebhook(makeInfo(), deps);

    const runId = dispatchedRunId(dispatch);
    expect(append).toHaveBeenCalledWith(webhookPayloadPath(runId), JSON.stringify(PAYLOAD));
  });

  it('dispatches normally when no object storage is configured', async () => {
    // Non-vacuity control in the other direction: the payload write is
    // best-effort, so an orchestrator with no `logStorage` still dispatches.
    const { deps, dispatch, append } = makeDeps({ logStorage: false });

    await processWebhook(makeInfo(), deps);

    expect(dispatch).toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('dispatches even when the payload write fails', async () => {
    // A storage outage must not cost the run: the per-repository path logs and
    // continues, and this one behaves identically.
    const { deps, dispatch, append } = makeDeps();
    append.mockRejectedValue(new Error('storage down'));

    await processWebhook(makeInfo(), deps);

    expect(dispatch).toHaveBeenCalled();
  });
});
