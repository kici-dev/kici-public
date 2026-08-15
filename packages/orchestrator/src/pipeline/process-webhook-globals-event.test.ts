/**
 * A cross-repo global workflow job carries the event that triggered it.
 *
 * The per-repository dispatch path writes the normalized event envelope into
 * every job config (`dispatch-matched-workflow.ts`, `envelopeEvent`), and the
 * agent reads it back as `ctx.event`. The organization-wide dispatch path built
 * its job configs directly and never wrote the field, so `ctx.event` was `{}`
 * for a global job — an SDK-typed payload that was never there, with no error.
 *
 * Both global paths are covered because they are separate call sites:
 * `tryDispatchGlobalsWithoutLockFile` (Phase F, no lock file resolves) and
 * `dispatchGlobalWorkflowsForOtherRepos` (Phase J, a lock file resolved). The
 * `sourceRepo` assertions are the load-bearing ones: it is the only field
 * naming the repo the event came from, so it is what an author needs to scope a
 * concurrency group (see `workflow-runner.test.ts`,
 * `buildConcurrencyGroupContext`) and what the Phase F path did not carry even
 * for trigger matching's own copy of the event.
 *
 * The fixture shape mirrors `process-webhook-globals-payload.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { processWebhook } from './process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';

const SOURCE_REPO = 'acme/app';
const GLOBAL_REPO = 'acme/org-workflows';

function makeInfo(): WebhookInfo {
  return {
    routingKey: 'github:1',
    deliveryId: `d-${Math.random().toString(36).slice(2)}`,
    event: 'pull_request',
    action: 'opened',
    provider: 'github',
    payload: { repository: { full_name: SOURCE_REPO }, number: 42 },
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

function makeDeps(over: { withLockFile?: boolean } = {}): {
  deps: Parameters<typeof processWebhook>[1];
  dispatch: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn().mockResolvedValue({ status: 'queued' });

  const bundle = {
    normalizer: {
      provider: 'github',
      normalizeEvent: () => ({
        type: 'pull_request',
        action: 'opened',
        payload: { number: 42 },
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

  return { deps, dispatch };
}

/** The `event` envelope the dispatched global job carries. */
function dispatchedEvent(dispatch: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(dispatch).toHaveBeenCalled();
  const jobConfig = dispatch.mock.calls[0][0].jobConfig as Record<string, unknown>;
  expect(jobConfig.isGlobalWorkflow).toBe(true);
  return jobConfig.event as Record<string, unknown>;
}

describe('a global workflow job carries its triggering event', () => {
  it('writes the normalized event into the job config on the no-lock-file path', async () => {
    const { deps, dispatch } = makeDeps();

    await processWebhook(makeInfo(), deps);

    expect(dispatchedEvent(dispatch)).toEqual(
      expect.objectContaining({
        type: 'pull_request',
        action: 'opened',
        targetBranch: 'main',
        sourceBranch: 'feature',
        senderUsername: 'octocat',
        // The repo the event came from — the workflow lives in GLOBAL_REPO, so
        // this is the only field distinguishing one source repo from another.
        sourceRepo: SOURCE_REPO,
      }),
    );
  });

  it('writes the normalized event into the job config on the lock-file path', async () => {
    const { deps, dispatch } = makeDeps({ withLockFile: true });

    await processWebhook(makeInfo(), deps);

    expect(dispatchedEvent(dispatch)).toEqual(
      expect.objectContaining({
        type: 'pull_request',
        action: 'opened',
        targetBranch: 'main',
        sourceBranch: 'feature',
        senderUsername: 'octocat',
        sourceRepo: SOURCE_REPO,
      }),
    );
  });

  it('carries the raw provider payload so ctx.event exposes it', async () => {
    // `rawPayloadFromEvent` reads `event.payload`, which is what an author gets
    // from the provider-specific half of `ctx.event`. An envelope without it is
    // still an empty payload from the author's side.
    const { deps, dispatch } = makeDeps({ withLockFile: true });

    await processWebhook(makeInfo(), deps);

    expect(dispatchedEvent(dispatch).payload).toEqual({ number: 42 });
  });
});
