import { describe, it, expect, vi } from 'vitest';
import type { Context, LockJob } from '@kici-dev/engine';
import {
  buildJobContextDisplayNames,
  effectiveContextRefs,
  resolveJobContextNames,
  resolveMultiEnvMergedData,
} from './job-contexts.js';

function makeEnv(id: string, name: string): Context {
  return {
    id,
    orgId: 'org-1',
    name,
    type: 'fixed',
    globPattern: null,
    branchRestrictions: [],
    triggerTypeFilters: [],
    repoPatterns: [],
    concurrencyLimit: null,
    concurrencyStrategy: 'queue',
    concurrencyTimeoutMs: 0,
    requiredReviewers: null,
    waitTimerSeconds: null,
    holdExpirySeconds: 3600,
    enabled: true,
    createdAt: '',
    updatedAt: '',
    createdBy: '',
  };
}

/** A workflow naming no workflow-level context. */
const NO_WF = {};

/** A job binding the given static names. */
function staticJob(...names: string[]): Pick<LockJob, 'contexts'> {
  return { contexts: names.map((value) => ({ value, dynamic: false })) };
}

describe('effectiveContextRefs', () => {
  it("places workflow-level names before the job's own", () => {
    // fails-when: workflow names are appended after the job's, so they win a key collision
    expect(effectiveContextRefs({ contexts: ['prod'] }, staticJob('job'))).toEqual([
      { value: 'prod', dynamic: false },
      { value: 'job', dynamic: false },
    ]);
  });

  it('binds workflow-level names on a job that names none itself', () => {
    // fails-when: a job with no contexts of its own drops the workflow-level ones
    expect(effectiveContextRefs({ contexts: ['prod'] }, {})).toEqual([
      { value: 'prod', dynamic: false },
    ]);
  });

  it("keeps one entry, at the job's position, for a name bound at both levels", () => {
    // fails-when: the same context is gated and resolved twice
    expect(
      effectiveContextRefs({ contexts: ['prod', 'prod', 'ops'] }, staticJob('x', 'prod')),
    ).toEqual([
      { value: 'ops', dynamic: false },
      { value: 'x', dynamic: false },
      { value: 'prod', dynamic: false },
    ]);
  });

  it("returns the job's own list unchanged when the workflow names none", () => {
    // breaks-if-wrong: a job-only binding, dynamic slot included, keeps its exact order
    const job = {
      contexts: [
        { value: 'a', dynamic: false },
        { value: '', dynamic: true },
      ],
    };
    expect(effectiveContextRefs(NO_WF, job)).toEqual(job.contexts);
  });
});

describe('resolveJobContextNames', () => {
  it('resolves static names verbatim in order', () => {
    const r = resolveJobContextNames(NO_WF, {
      contexts: [
        { value: 'staging', dynamic: false },
        { value: 'my-testing', dynamic: false },
      ],
    } as unknown as LockJob);
    expect(r.names).toEqual(['staging', 'my-testing']);
    expect(r.needsInit).toBe(false);
  });

  it('flags needsInit for a dynamic element and keeps the static names', () => {
    const r = resolveJobContextNames(NO_WF, {
      contexts: [
        { value: 'staging', dynamic: false },
        { value: '', dynamic: true },
      ],
    } as unknown as LockJob);
    expect(r.names).toEqual(['staging']);
    expect(r.needsInit).toBe(true);
  });
});

describe('buildJobContextDisplayNames', () => {
  it('returns an empty list when no context is bound', () => {
    expect(buildJobContextDisplayNames(NO_WF, {} as unknown as LockJob)).toEqual([]);
  });

  it("lists the workflow-level names ahead of the job's own", () => {
    // fails-when: the persisted job row omits a context the job was gated on
    expect(buildJobContextDisplayNames({ contexts: ['prod'] }, staticJob('job'))).toEqual([
      'prod',
      'job',
    ]);
  });

  it('keeps static names verbatim in order', () => {
    expect(
      buildJobContextDisplayNames(NO_WF, {
        contexts: [
          { value: 'staging', dynamic: false },
          { value: 'my-testing', dynamic: false },
        ],
      } as unknown as LockJob),
    ).toEqual(['staging', 'my-testing']);
  });

  it('uses a placeholder for every dynamic slot', () => {
    expect(
      buildJobContextDisplayNames(NO_WF, {
        contexts: [
          { value: 'staging', dynamic: false },
          { value: '', dynamic: true },
        ],
      } as unknown as LockJob),
    ).toEqual(['staging', '(dynamic)']);
  });
});

describe('resolveMultiEnvMergedData', () => {
  it('folds vars and secrets last-wins, keeping namespaced per-env secrets', async () => {
    const varStore = {
      getResolvedVars: vi.fn(async (_org: string, envId: string) =>
        envId === 'env-staging'
          ? { SHARED: 'staging', STAGING_ONLY: 's' }
          : { SHARED: 'my-testing', TEST_ONLY: 't' },
      ),
    } as any;
    const secretResolver = {
      resolveForContext: vi.fn(async (_org: string, context: { id: string }) =>
        context.id === 'env-staging'
          ? { DB_URL: 'staging-db', STAGING_SECRET: 'x' }
          : { DB_URL: 'my-testing-db' },
      ),
    } as any;

    const merged = await resolveMultiEnvMergedData({
      deps: { variableStore: varStore, secretResolver },
      orgId: 'org-1',
      entries: [
        { name: 'staging', env: makeEnv('env-staging', 'staging') },
        { name: 'my-testing', env: makeEnv('env-testing', 'my-testing') },
      ],
    });

    expect(merged.contextVars).toEqual({
      SHARED: 'my-testing',
      STAGING_ONLY: 's',
      TEST_ONLY: 't',
    });
    expect(merged.jobSecrets).toEqual({
      DB_URL: 'my-testing-db',
      STAGING_SECRET: 'x',
    });
    expect(merged.jobNamespacedSecrets).toEqual({
      staging: { DB_URL: 'staging-db', STAGING_SECRET: 'x' },
      'my-testing': { DB_URL: 'my-testing-db' },
    });
  });

  it('resolves a glob-matched context through its own row, namespaced by the declared name', async () => {
    // 'deploy-prod' matched the glob context 'deploy-*' (row env-deploy-glob).
    const resolveForContext = vi.fn(async (_org: string, context: { id: string }) =>
      context.id === 'env-deploy-glob' ? { DEPLOY_TOKEN: 'tok' } : {},
    );
    const merged = await resolveMultiEnvMergedData({
      deps: { secretResolver: { resolveForContext } as any },
      orgId: 'org-1',
      entries: [{ name: 'deploy-prod', env: makeEnv('env-deploy-glob', 'deploy-*') }],
    });

    // fails-when: secrets resolve by the declared name, which names no context row
    expect(resolveForContext).toHaveBeenCalledWith(
      'org-1',
      { id: 'env-deploy-glob', name: 'deploy-prod' },
      undefined,
    );
    expect(merged.jobSecrets).toEqual({ DEPLOY_TOKEN: 'tok' });
    expect(merged.jobNamespacedSecrets).toEqual({ 'deploy-prod': { DEPLOY_TOKEN: 'tok' } });
  });

  it('omits empty maps', async () => {
    const merged = await resolveMultiEnvMergedData({
      deps: {
        variableStore: { getResolvedVars: vi.fn(async () => ({})) } as any,
        secretResolver: { resolveForContext: vi.fn(async () => ({})) } as any,
      },
      orgId: 'org-1',
      entries: [{ name: 'a', env: makeEnv('env-a', 'a') }],
    });
    expect(merged.contextVars).toBeUndefined();
    expect(merged.jobSecrets).toBeUndefined();
    expect(merged.jobNamespacedSecrets).toBeUndefined();
  });
});
