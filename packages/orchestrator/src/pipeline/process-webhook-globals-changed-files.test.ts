/**
 * The organization-wide pass resolves the event's changed files before
 * matching, so a global workflow's `push()` / `pr()` `paths` filter decides
 * against the real diff — on a repository with no lock file, and on one whose
 * own lock file declares no `paths` at all.
 *
 * The fixture shape mirrors `process-webhook-globals-event.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChangedFilesResult } from '@kici-dev/engine';
import { processWebhook } from './process-webhook.js';
import type { WebhookInfo } from '../webhook/handler.js';

const SOURCE_REPO = 'acme/app';
const GLOBAL_REPO = 'acme/org-workflows';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function makeInfo(): WebhookInfo {
  return {
    routingKey: 'github:1',
    deliveryId: `d-${Math.random().toString(36).slice(2)}`,
    event: 'push',
    action: null,
    provider: 'github',
    payload: {
      ref: 'refs/heads/main',
      before: SHA_A,
      after: SHA_B,
      repository: { full_name: SOURCE_REPO },
    },
  } as unknown as WebhookInfo;
}

function makeGlobalRegistration() {
  return {
    id: 'reg-global-paths',
    routingKey: 'github:1',
    repoIdentifier: GLOBAL_REPO,
    commitSha: 'globalsha',
    sourceFile: '.kici/workflows/org.ts',
    lockEntry: {
      name: 'org-src-guard',
      contentHash: 'ghash',
      compileSchemaVersion: 1,
      triggers: [{ _type: 'push', branches: [], paths: ['src/**'] }],
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

/** The event repository's own lock file: one push workflow with no `paths`. */
const SOURCE_LOCK_FILE = {
  schemaVersion: 9,
  source: { file: '.kici/workflows/ci.ts', export: '#default' },
  contentHash: 'srchash',
  workflows: [
    {
      name: 'src-push-no-paths',
      contentHash: 'shash',
      compileSchemaVersion: 1,
      triggers: [{ _type: 'push', branches: ['release'], paths: [] }],
      jobs: [],
    },
  ],
};

function makeDeps(changed: ChangedFilesResult, over: { withLockFile?: boolean } = {}) {
  const dispatch = vi.fn().mockResolvedValue({ status: 'queued' });
  const getChangedFiles = vi.fn().mockResolvedValue(changed);
  const bundle = {
    normalizer: {
      provider: 'github',
      normalizeEvent: (_e: string, _a: unknown, payload: Record<string, unknown>) => ({
        type: 'push',
        payload,
        targetBranch: 'main',
        provider: 'github',
      }),
      extractRef: () => SHA_B,
      extractRepoIdentifier: () => SOURCE_REPO,
      extractCredentials: () => ({ token: 'src-token' }),
    },
    checkStatusPoster: {
      provider: 'github',
      postCheckStatus: vi.fn().mockResolvedValue(undefined),
    },
    changedFilesFetcher: { provider: 'github', getChangedFiles },
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
    lockFileCache: { get: vi.fn(async () => (over.withLockFile ? SOURCE_LOCK_FILE : null)) },
  } as unknown as Parameters<typeof processWebhook>[1];

  return { deps, dispatch, getChangedFiles };
}

describe('the no-lock-file organization-wide pass resolves changed files', () => {
  // fails-when: the pass matches global workflows against the raw event, which never matches a path filter
  it('runs a global workflow whose paths the diff touches', async () => {
    const { deps, dispatch, getChangedFiles } = makeDeps({
      files: ['src/a.ts'],
      status: 'fetched',
    });

    await processWebhook(makeInfo(), deps);

    expect(getChangedFiles).toHaveBeenCalledWith(
      SOURCE_REPO,
      'push',
      expect.objectContaining({ before: SHA_A, after: SHA_B }),
      { token: 'src-token' },
    );
    expect(dispatch).toHaveBeenCalled();
    const jobConfig = dispatch.mock.calls[0][0].jobConfig as Record<string, unknown>;
    expect(jobConfig.isGlobalWorkflow).toBe(true);
  });

  // breaks-if-wrong: a diff that misses the paths must still suppress the global workflow
  it('does not run a global workflow whose paths the diff misses', async () => {
    const { deps, dispatch } = makeDeps({ files: ['docs/a.md'], status: 'fetched' });

    await processWebhook(makeInfo(), deps);

    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('the organization-wide pass on a repository with a lock file resolves changed files', () => {
  // The event repository's own lock declares no `paths`, so only the global
  // workflow's filter makes the diff needed.
  // fails-when: the resolver reads only the repository's own lock, reports `skipped`, and the global's paths never match
  it('runs a global workflow whose paths the diff touches', async () => {
    const { deps, dispatch, getChangedFiles } = makeDeps(
      { files: ['src/a.ts'], status: 'fetched' },
      { withLockFile: true },
    );

    await processWebhook(makeInfo(), deps);

    expect(getChangedFiles).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalled();
    const jobConfig = dispatch.mock.calls[0][0].jobConfig as Record<string, unknown>;
    expect(jobConfig.isGlobalWorkflow).toBe(true);
  });

  // breaks-if-wrong: a diff that misses the paths must still suppress the global workflow
  it('does not run a global workflow whose paths the diff misses', async () => {
    const { deps, dispatch, getChangedFiles } = makeDeps(
      { files: ['docs/a.md'], status: 'fetched' },
      { withLockFile: true },
    );

    await processWebhook(makeInfo(), deps);

    expect(getChangedFiles).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
