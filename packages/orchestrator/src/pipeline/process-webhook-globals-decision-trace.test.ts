/**
 * The decision trace forwarded to the Platform covers organization-wide
 * workflows, and names the repo each one is defined in.
 *
 * A per-repo workflow's author can read its trace off the delivery, because
 * the started `execution.event` carries one summary per lock-file workflow. An
 * organization-wide workflow lives in a different repo, so it never appears in
 * that lock file — and its author, who sees neither the source repo's lock file
 * nor the orchestrator's logs, had nothing at all to read. A global that did
 * not fire and a global that was never registered looked identical.
 *
 * So the global pass returns its own decision summaries, each tagged with
 * `workflowRepoIdentifier`, and Phase K concatenates them onto the same array.
 *
 * The fixture shape mirrors `process-webhook-globals-event.test.ts`; the
 * lock-file path is the one under test because Phase K only runs there.
 */
import { describe, it, expect, vi } from 'vitest';
import { processWebhook } from './process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';

const SOURCE_REPO = 'acme/app';
const GLOBAL_REPO = 'acme/org-workflows';
const MATCHING_GLOBAL = 'org-guard';
const EXCLUDED_GLOBAL = 'org-elsewhere';

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

/** A global registration whose `repos` filter, when given, scopes it. */
function makeGlobalRegistration(name: string, repos?: Array<{ type: 'glob'; pattern: string }>) {
  return {
    id: `reg-${name}`,
    routingKey: 'github:1',
    repoIdentifier: GLOBAL_REPO,
    commitSha: 'globalsha',
    sourceFile: '.kici/workflows/org.ts',
    lockEntry: {
      name,
      contentHash: `${name}-hash`,
      compileSchemaVersion: 1,
      triggers: [
        {
          _type: 'pr',
          events: ['opened'],
          targetBranches: [],
          sourceBranches: [],
          paths: [],
          ...(repos === undefined ? {} : { repos }),
        },
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
  send: ReturnType<typeof vi.fn>;
} {
  const dispatch = vi.fn().mockResolvedValue({ status: 'queued' });
  const send = vi.fn();

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
    lockFileFetcher: { fetchLockFile: vi.fn() },
    repoUrlBuilder: { buildCloneUrl: () => 'https://example.invalid/repo.git' },
  };

  const deps = {
    dedup: { claim: vi.fn(async () => true), exists: vi.fn(), mark: vi.fn(), cleanup: vi.fn() },
    providerRegistry: { getByRoutingKey: () => bundle, getAll: () => [] },
    orchestratorMode: 'platform',
    platformClient: { send },
    registrationIndex: {
      refreshIfNeeded: vi.fn(async () => undefined),
      getGlobalByOrgAndTriggerType: () => [
        makeGlobalRegistration(MATCHING_GLOBAL),
        makeGlobalRegistration(EXCLUDED_GLOBAL, [{ type: 'glob', pattern: 'other/*' }]),
      ],
      getByRepo: () => [],
      getByOrgAndEvent: () => [],
    },
    dispatcher: { dispatch },
    lockFileCache: {
      get: vi.fn(async () => ({
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
      })),
    },
  } as unknown as Parameters<typeof processWebhook>[1];

  return { deps, send };
}

/** The `data` payload of the started `execution.event`. */
function startedEventData(send: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const started = send.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .find((msg) => msg.type === 'execution.event' && msg.event === 'started');
  expect(started).toBeDefined();
  return started?.data as Record<string, unknown>;
}

/** The decision summaries carried by the started `execution.event`. */
function forwardedDecisions(send: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return startedEventData(send).decisions as Array<Record<string, unknown>>;
}

describe('the forwarded decision trace covers global workflows', () => {
  it('tags every global summary with the repo that defines the workflow', async () => {
    const { deps, send } = makeDeps();

    await processWebhook(makeInfo(), deps);

    const decisions = forwardedDecisions(send);
    expect(decisions).toContainEqual(
      expect.objectContaining({
        workflowName: MATCHING_GLOBAL,
        matched: true,
        workflowRepoIdentifier: GLOBAL_REPO,
      }),
    );
  });

  it('carries a global excluded by its repo filter, so its author can see why', async () => {
    const { deps, send } = makeDeps();

    await processWebhook(makeInfo(), deps);

    const excluded = forwardedDecisions(send).find(
      (decision) => decision.workflowName === EXCLUDED_GLOBAL,
    );
    expect(excluded).toBeDefined();
    expect(excluded?.matched).toBe(false);
    expect(excluded?.workflowRepoIdentifier).toBe(GLOBAL_REPO);
    // The individual checks are what name the filter that rejected it.
    expect(excluded?.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: 'repo', passed: false })]),
    );
  });

  it('counts the globals in the totalWorkflows it reports beside them', async () => {
    const { deps, send } = makeDeps();

    await processWebhook(makeInfo(), deps);

    const data = startedEventData(send);
    // The count and the array are on the same message, so a count that excludes
    // the globals the array carries is a field that contradicts its neighbour.
    expect(data.totalWorkflows).toBe((data.decisions as unknown[]).length);
    // Positive control: the delivery really did evaluate both halves, so the
    // equality above is not two zeroes agreeing.
    expect(data.totalWorkflows).toBeGreaterThan(1);
  });

  it('forwards the trace for a source repo that has no lock file at all', async () => {
    // A repository with no `.kici/` lock file is the canonical target of an
    // organization-wide workflow — nothing else can run for it. That path
    // returned before the trace was forwarded, so the one case the trace exists
    // for produced no trace.
    const { deps, send } = makeDeps();
    (deps as unknown as { lockFileCache: { get: () => Promise<null> } }).lockFileCache.get =
      async () => null;

    await processWebhook(makeInfo(), deps);

    const decisions = forwardedDecisions(send);
    expect(decisions).toContainEqual(
      expect.objectContaining({
        workflowName: MATCHING_GLOBAL,
        matched: true,
        workflowRepoIdentifier: GLOBAL_REPO,
      }),
    );
    // Positive control: the excluded global is present too, so the trace is the
    // whole organization-wide pass rather than only what dispatched.
    expect(decisions).toContainEqual(
      expect.objectContaining({ workflowName: EXCLUDED_GLOBAL, matched: false }),
    );
  });
});
