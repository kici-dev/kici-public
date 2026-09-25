/**
 * An organization-wide workflow's git-credential declaration reaches BOTH
 * halves of the authorization model.
 *
 * The credential relay pins a workflow-supplied `ref` to
 * `execution_jobs.git_credentials`, which the orchestrator writes at dispatch.
 * The agent, meanwhile, names an entry out of `jobConfig.gitCredentials`. The
 * two must be written together: a path that ships the map to the agent but
 * registers the job without it leaves the relay reading an empty declaration,
 * so every request the workflow legitimately makes is refused as undeclared.
 *
 * The fixture shape mirrors `process-webhook-globals-secrets.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { processWebhook } from './process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';

const SOURCE_REPO = 'acme/app';
const GLOBAL_REPO = 'acme/org-workflows';

const DECLARED = {
  default: { kind: 'token', tokenSecret: 'ci:FORGE_PAT' },
} as const;

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
          gitCredentials: DECLARED,
        },
      ],
    },
  };
}

function makeDeps(): {
  deps: Parameters<typeof processWebhook>[1];
  dispatch: ReturnType<typeof vi.fn>;
  addJobsToRun: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn().mockResolvedValue({ status: 'queued', jobId: 'job-1' });
  const addJobsToRun = vi.fn().mockResolvedValue(undefined);

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
    globalWorkflowPolicy: {
      isWorkflowRepoAllowed: vi.fn(async () => ({ allowed: true })),
      isSourceRepoAllowed: vi.fn(async () => ({ allowed: true })),
    },
    executionTracker: {
      onExecutionStarted: vi.fn(async () => undefined),
      holdRunForPendingJobs: vi.fn(() => true),
      releasePendingJobsHold: vi.fn(async () => undefined),
      addJobsToRun,
      onJobStatus: vi.fn(async () => undefined),
      failRun: vi.fn(async () => undefined),
    },
    dispatcher: { dispatch },
    lockFileCache: { get: vi.fn(async () => null) },
  } as unknown as Parameters<typeof processWebhook>[1];

  return { deps, dispatch, addJobsToRun };
}

describe('an organization-wide workflow job carries its git-credential declaration', () => {
  it('ships the declared map to the agent in the job config', async () => {
    const { deps, dispatch } = makeDeps();

    await processWebhook(makeInfo(), deps);

    expect(dispatch).toHaveBeenCalled();
    const jobConfig = dispatch.mock.calls[0][0].jobConfig as Record<string, unknown>;
    expect(jobConfig.gitCredentials).toEqual(DECLARED);
  });

  it('registers the same declaration on the job row the relay reads', async () => {
    const { deps, addJobsToRun } = makeDeps();

    await processWebhook(makeInfo(), deps);

    expect(addJobsToRun).toHaveBeenCalled();
    const jobs = addJobsToRun.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    // Without this the relay reads an empty declaration and refuses every
    // workflow-supplied ref the job config above tells the agent to send.
    expect(jobs[0].gitCredentials).toEqual(DECLARED);
  });
});
