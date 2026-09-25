/**
 * A global job binds its own `contexts:`, checked against the workflow
 * repository, and a sibling job that binds none receives nothing.
 *
 * The secrets a global job binds belong to the repository that defines the
 * workflow, so a context's `repoPatterns` rule is checked against that
 * repository — never against the repository the event came from, which the
 * workflow's author does not control.
 *
 * The fixture shape mirrors `process-webhook-globals-payload.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { ContextGateRejectReason } from '@kici-dev/engine';
import { processWebhook } from './process-webhook.js';
import { makeJobContextRow } from './dispatch-matched-workflow.test-helpers.js';
import type { WebhookInfo } from '../webhook/handler.js';

const SOURCE_REPO = 'acme/app';
const GLOBAL_REPO = 'acme/org-workflows';
const CONTEXT_NAME = 'deploy';
const SECRET_VALUE = 'super-secret';

/** Every job-config key by which secret material reaches an agent. */
const SECRET_BEARING_KEYS = ['secrets', 'namespacedSecrets'] as const;

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

/** A global workflow whose `publish` job binds `deploy` and whose `scan` job binds nothing. */
function makeGlobalRegistration() {
  const job = (name: string) => ({
    _type: 'static',
    name,
    runsOn: [{ kind: 'exact', value: 'default' }],
    needs: [],
    steps: [{ name, hasOutputs: false }],
  });
  return {
    id: 'reg-global-1',
    routingKey: 'github:1',
    repoIdentifier: GLOBAL_REPO,
    commitSha: 'globalsha',
    defaultBranch: 'main',
    sourceFile: '.kici/workflows/org.ts',
    lockEntry: {
      name: 'org-guard',
      contentHash: 'ghash',
      compileSchemaVersion: 1,
      triggers: [
        { _type: 'pr', events: ['opened'], targetBranches: [], sourceBranches: [], paths: [] },
      ],
      jobs: [
        { ...job('publish'), contexts: [{ value: CONTEXT_NAME, dynamic: false }] },
        job('scan'),
      ],
    },
  };
}

/** Deps whose `deploy` context admits only the repositories in `repoPatterns`. */
function makeDeps(repoPatterns: string[]) {
  const dispatch = vi.fn().mockResolvedValue({ status: 'queued', jobId: 'job-1' });
  const onJobStatus = vi.fn().mockResolvedValue(undefined);
  const resolveForContext = vi.fn().mockResolvedValue({ PROD_TOKEN: SECRET_VALUE });

  const bundle = {
    normalizer: {
      provider: 'github',
      normalizeEvent: () => ({
        type: 'pull_request',
        action: 'opened',
        payload: {},
        targetBranch: 'main',
        sourceBranch: 'feature',
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
    },
    repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://example.invalid/${repo}.git` },
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
    contextStore: {
      matchContext: async (_org: string, name: string) =>
        name === CONTEXT_NAME
          ? makeJobContextRow(name, {} as never, { repo_patterns: repoPatterns })
          : null,
    },
    secretResolver: {
      resolveForContext,
      resolveNamedInternal: vi.fn(async () => null),
      resolveForContextWithMeta: resolveForContext,
    },
    executionTracker: {
      onExecutionStarted: vi.fn().mockResolvedValue(undefined),
      addJobsToRun: vi.fn().mockResolvedValue(undefined),
      onJobStatus,
      holdRunForPendingJobs: vi.fn().mockReturnValue(true),
      releasePendingJobsHold: vi.fn().mockResolvedValue(undefined),
    },
    globalWorkflowPolicy: {
      isWorkflowRepoAllowed: vi.fn(async () => ({ allowed: true })),
      isSourceRepoAllowed: vi.fn(async () => ({ allowed: true })),
    },
    dispatcher: { dispatch },
    lockFileCache: { get: vi.fn(async () => null) },
  } as unknown as Parameters<typeof processWebhook>[1];

  /** The dispatched job config of `name`, or undefined when it was not dispatched. */
  const jobConfigOf = (name: string) =>
    dispatch.mock.calls.map((c) => c[0]).find((input) => input.jobName === name)?.jobConfig as
      Record<string, unknown> | undefined;
  return { deps, dispatch, onJobStatus, jobConfigOf };
}

describe('an organization-wide workflow job binds its own contexts', () => {
  it('a job binding a context the workflow repository may use receives its secrets', async () => {
    // fails-when: a global job's contexts are ignored, so the job runs with no secrets
    const { deps, jobConfigOf } = makeDeps([GLOBAL_REPO]);

    await processWebhook(makeInfo(), deps);

    const publish = jobConfigOf('publish');
    expect(publish?.isGlobalWorkflow).toBe(true);
    expect(publish?.secrets).toMatchObject({ PROD_TOKEN: SECRET_VALUE });
  });

  it('a sibling job that binds no context receives no secret material', async () => {
    // fails-when: a context bound by one job leaks into a sibling that bound none
    const { deps, jobConfigOf } = makeDeps([GLOBAL_REPO]);

    await processWebhook(makeInfo(), deps);

    const scan = jobConfigOf('scan');
    // Positive control: the sibling really was dispatched, from the same run.
    expect(scan).toBeDefined();
    for (const key of SECRET_BEARING_KEYS) {
      expect(scan).not.toHaveProperty(key);
    }
  });

  it('a context whose repoPatterns name only the source repository refuses the job', async () => {
    // fails-when: the context's repository rule is checked against the source repo
    // breaks-if-wrong: the same context naming the workflow repo must bind (case above)
    const { deps, jobConfigOf, onJobStatus } = makeDeps([SOURCE_REPO]);

    await processWebhook(makeInfo(), deps);

    expect(jobConfigOf('publish')).toBeUndefined();
    // The sibling that binds nothing still runs.
    expect(jobConfigOf('scan')).toBeDefined();
    const rejection = onJobStatus.mock.calls.find((call) =>
      String(call[1]).startsWith('rejected-'),
    );
    const message = (rejection?.[5] as { initFailure?: { message: string } } | undefined)
      ?.initFailure?.message;
    expect(message).toContain(ContextGateRejectReason.enum.repo_unmatched);
  });
});
