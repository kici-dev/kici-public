import { describe, it, expect, vi } from 'vitest';
import type { Environment, LockJob } from '@kici-dev/engine';
import {
  buildJobEnvironmentDisplayNames,
  resolveJobEnvironmentNames,
  resolveMultiEnvMergedData,
} from './job-environments.js';

function makeEnv(id: string, name: string): Environment {
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

describe('resolveJobEnvironmentNames', () => {
  it('resolves static names verbatim in order', () => {
    const r = resolveJobEnvironmentNames(
      {
        environments: [
          { value: 'staging', dynamic: false },
          { value: 'my-testing', dynamic: false },
        ],
      } as unknown as LockJob,
      [undefined, undefined],
    );
    expect(r.names).toEqual(['staging', 'my-testing']);
    expect(r.needsInit).toBe(false);
  });

  it('uses pre-evaluated inline names for pure dynamic elements', () => {
    const r = resolveJobEnvironmentNames(
      {
        environments: [
          { value: 'staging', dynamic: false },
          { value: { _type: 'inline', expression: '(e) => e.x' }, dynamic: true },
        ],
      } as unknown as LockJob,
      [undefined, 'preview'],
    );
    expect(r.names).toEqual(['staging', 'preview']);
    expect(r.needsInit).toBe(false);
  });

  it('flags needsInit for an impure dynamic element', () => {
    const r = resolveJobEnvironmentNames(
      { environments: [{ value: '', dynamic: true }] } as unknown as LockJob,
      [undefined],
    );
    expect(r.needsInit).toBe(true);
    expect(r.names).toEqual([]);
  });
});

describe('buildJobEnvironmentDisplayNames', () => {
  it('returns an empty list when no environment is bound', () => {
    expect(buildJobEnvironmentDisplayNames({} as unknown as LockJob, [])).toEqual([]);
  });

  it('keeps static names verbatim in order', () => {
    expect(
      buildJobEnvironmentDisplayNames(
        {
          environments: [
            { value: 'staging', dynamic: false },
            { value: 'my-testing', dynamic: false },
          ],
        } as unknown as LockJob,
        [undefined, undefined],
      ),
    ).toEqual(['staging', 'my-testing']);
  });

  it('uses resolved inline names and a placeholder for unresolved dynamic slots', () => {
    expect(
      buildJobEnvironmentDisplayNames(
        {
          environments: [
            { value: 'staging', dynamic: false },
            { value: { _type: 'inline', expression: '(e) => e.x' }, dynamic: true },
            { value: '', dynamic: true },
          ],
        } as unknown as LockJob,
        [undefined, 'preview', undefined],
      ),
    ).toEqual(['staging', 'preview', '(dynamic)']);
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

    expect(merged.environmentVars).toEqual({
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
    expect(merged.environmentVars).toBeUndefined();
    expect(merged.jobSecrets).toBeUndefined();
    expect(merged.jobNamespacedSecrets).toBeUndefined();
  });
});
