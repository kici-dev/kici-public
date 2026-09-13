import { describe, it, expect, vi } from 'vitest';
import type { Context, LockJob } from '@kici-dev/engine';
import {
  buildJobContextDisplayNames,
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

describe('resolveJobContextNames', () => {
  it('resolves static names verbatim in order', () => {
    const r = resolveJobContextNames({
      contexts: [
        { value: 'staging', dynamic: false },
        { value: 'my-testing', dynamic: false },
      ],
    } as unknown as LockJob);
    expect(r.names).toEqual(['staging', 'my-testing']);
    expect(r.needsInit).toBe(false);
  });

  it('flags needsInit for a pure inline dynamic element and drops it from names', () => {
    const r = resolveJobContextNames({
      contexts: [
        { value: 'staging', dynamic: false },
        { value: { _type: 'inline', expression: '(e) => e.x' }, dynamic: true },
      ],
    } as unknown as LockJob);
    expect(r.names).toEqual(['staging']);
    expect(r.needsInit).toBe(true);
  });

  it('flags needsInit for an impure dynamic element', () => {
    const r = resolveJobContextNames({
      contexts: [{ value: '', dynamic: true }],
    } as unknown as LockJob);
    expect(r.needsInit).toBe(true);
    expect(r.names).toEqual([]);
  });
});

describe('buildJobContextDisplayNames', () => {
  it('returns an empty list when no context is bound', () => {
    expect(buildJobContextDisplayNames({} as unknown as LockJob)).toEqual([]);
  });

  it('keeps static names verbatim in order', () => {
    expect(
      buildJobContextDisplayNames({
        contexts: [
          { value: 'staging', dynamic: false },
          { value: 'my-testing', dynamic: false },
        ],
      } as unknown as LockJob),
    ).toEqual(['staging', 'my-testing']);
  });

  it('uses a placeholder for every dynamic slot', () => {
    expect(
      buildJobContextDisplayNames({
        contexts: [
          { value: 'staging', dynamic: false },
          { value: { _type: 'inline', expression: '(e) => e.x' }, dynamic: true },
          { value: '', dynamic: true },
        ],
      } as unknown as LockJob),
    ).toEqual(['staging', '(dynamic)', '(dynamic)']);
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
      resolveForJob: vi.fn(async (_org: string, name: string) =>
        name === 'staging'
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

  it('omits empty maps', async () => {
    const merged = await resolveMultiEnvMergedData({
      deps: {
        variableStore: { getResolvedVars: vi.fn(async () => ({})) } as any,
        secretResolver: { resolveForJob: vi.fn(async () => ({})) } as any,
      },
      orgId: 'org-1',
      entries: [{ name: 'a', env: makeEnv('env-a', 'a') }],
    });
    expect(merged.contextVars).toBeUndefined();
    expect(merged.jobSecrets).toBeUndefined();
    expect(merged.jobNamespacedSecrets).toBeUndefined();
  });
});
