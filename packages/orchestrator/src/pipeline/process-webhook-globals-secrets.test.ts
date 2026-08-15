/**
 * An organization-wide workflow's job is dispatched with no secret material.
 *
 * The per-repository dispatch path resolves the workflow's declared `contexts`
 * and writes `secrets` / `namespacedSecrets` / `runPublicKey` into every job
 * config (`dispatch-matched-workflow.ts`, `makeBuildJobConfig`). The
 * organization-wide path builds its job configs directly and resolves nothing —
 * it records the run with `dispatchedContexts: undefined` precisely because "this
 * path binds no secret contexts".
 *
 * That is the fact `global_workflow_elevated_repos` was meant to gate, and it is
 * why the list is inert: there is no secret injection on this path for a grant to
 * widen. `GlobalWorkflowPolicy.isElevatedAccessAllowed` is deprecated rather than
 * enforced for the same reason (see its doc comment and
 * `global-workflow-policy.test.ts`), and this test is the behavioural half of
 * that claim — it fails the moment secret material starts reaching a global job,
 * which is exactly when the elevated-access question has to be reopened.
 *
 * The fixture shape mirrors `process-webhook-globals-payload.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { processWebhook } from './process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';

const SOURCE_REPO = 'acme/app';
const GLOBAL_REPO = 'acme/org-workflows';

/** Every job-config key by which secret material reaches an agent. */
const SECRET_BEARING_KEYS = [
  'secrets',
  'namespacedSecrets',
  'runWideFlatSecrets',
  'installEnvSecrets',
  'runPublicKey',
  'runPublicKeyBase64',
] as const;

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
      // The workflow declares a secret context. The per-repository path would
      // resolve it; this path does not look at it at all.
      contexts: ['prod'],
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

function makeDeps(): {
  deps: Parameters<typeof processWebhook>[1];
  dispatch: ReturnType<typeof vi.fn>;
  resolveForJob: ReturnType<typeof vi.fn>;
  isElevatedAccessAllowed: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn().mockResolvedValue({ status: 'queued' });
  // A resolver that would hand out a secret if anything asked it to.
  const resolveForJob = vi.fn().mockResolvedValue({ PROD_TOKEN: 'super-secret' });
  const isElevatedAccessAllowed = vi.fn(async () => true);

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
      postGlobalWorkflowsSkippedCheck: vi.fn().mockResolvedValue(undefined),
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
    // Both are wired so a resolution attempt would be observable rather than
    // failing on an absent dependency.
    secretResolver: { resolveForJob, resolveNamed: vi.fn(), resolveForJobWithMeta: vi.fn() },
    globalWorkflowPolicy: {
      isWorkflowRepoAllowed: vi.fn(async () => ({ allowed: true })),
      isSourceRepoAllowed: vi.fn(async () => ({ allowed: true })),
      isElevatedAccessAllowed,
    },
    dispatcher: { dispatch },
    lockFileCache: { get: vi.fn(async () => null) },
  } as unknown as Parameters<typeof processWebhook>[1];

  return { deps, dispatch, resolveForJob, isElevatedAccessAllowed };
}

describe('an organization-wide workflow job carries no secret material', () => {
  it('writes no secret-bearing key into the dispatched job config', async () => {
    const { deps, dispatch } = makeDeps();

    await processWebhook(makeInfo(), deps);

    expect(dispatch).toHaveBeenCalled();
    const jobConfig = dispatch.mock.calls[0][0].jobConfig as Record<string, unknown>;
    expect(jobConfig.isGlobalWorkflow).toBe(true);
    for (const key of SECRET_BEARING_KEYS) {
      expect(jobConfig).not.toHaveProperty(key);
    }
  });

  it('never asks the secret resolver for the workflow declared contexts', async () => {
    const { deps, dispatch, resolveForJob } = makeDeps();

    await processWebhook(makeInfo(), deps);

    expect(dispatch).toHaveBeenCalled();
    expect(resolveForJob).not.toHaveBeenCalled();
  });

  it('never consults the elevated-access list, even when it would say yes', async () => {
    // The grant is configured and would return true. Nothing asks — which is
    // the whole finding: the setting names a permission no code reads.
    const { deps, dispatch, isElevatedAccessAllowed } = makeDeps();

    await processWebhook(makeInfo(), deps);

    expect(dispatch).toHaveBeenCalled();
    expect(isElevatedAccessAllowed).not.toHaveBeenCalled();
  });
});
