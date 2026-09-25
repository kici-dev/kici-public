import { describe, expect, it } from 'vitest';
import {
  cacheRepoIdFor,
  globalJobConfigFields,
  globalJobConfigFor,
  policyBranch,
  policyRepo,
  policyRoutingKey,
  workflowRepoProvenance,
  type GlobalDispatchIdentity,
} from './global-dispatch-identity.js';

const g: GlobalDispatchIdentity = {
  workflowRepoIdentifier: 'org/ci',
  workflowSha: 'a1',
  workflowBranch: 'main',
  workflowRoutingKey: 'rk',
  workflowProviderContext: {},
  workflowBundle: undefined,
  workflowCredentials: {},
};

describe('global dispatch identity', () => {
  it('same-repo ctx collapses to the event repo and branch', () => {
    // fails-when: any helper reads a workflow-repo value for a ctx with no `global`
    const ctx = { repoIdentifier: 'org/app', event: { targetBranch: 'dev' } };
    expect(policyRepo(ctx)).toBe('org/app');
    expect(policyBranch(ctx)).toBe('dev');
    expect(cacheRepoIdFor(ctx)).toBe('org/app');
    expect(workflowRepoProvenance(ctx)).toBeUndefined();
    expect(globalJobConfigFields(ctx, 'https://example/org/ci.git')).toEqual({});
  });

  it('global ctx uses the workflow repo and its registered branch, not the event branch', () => {
    // fails-when: policyBranch returns event.targetBranch for a global run (B's main would satisfy A's main rule)
    const ctx = {
      repoIdentifier: 'org/app',
      event: { targetBranch: 'main' },
      global: { ...g, workflowBranch: 'release' },
    };
    expect(policyRepo(ctx)).toBe('org/ci');
    expect(policyBranch(ctx)).toBe('release');
    expect(cacheRepoIdFor(ctx)).toBe('org/ci::org/app');
    expect(workflowRepoProvenance(ctx)).toEqual({
      identifier: 'org/ci',
      sha: 'a1',
      branch: 'release',
    });
  });

  it('policy branch comes from the registration even when the event carries no branch', () => {
    // fails-when: policyBranch falls back to the (empty) event branch
    const ctx = { repoIdentifier: 'org/app', event: { targetBranch: '' }, global: g };
    expect(policyBranch(ctx)).toBe('main');
  });

  it('a registration with no recorded branch presents the empty branch', () => {
    // breaks-if-wrong: must be '' (matches no branch rule), never undefined or the event branch
    const ctx = {
      repoIdentifier: 'org/app',
      event: { targetBranch: 'main' },
      global: { ...g, workflowBranch: null },
    };
    expect(policyBranch(ctx)).toBe('');
  });

  it('global job config carries the dual-checkout fields', () => {
    // fails-when: a field the agent's dual clone reads is missing or renamed
    const ctx = { repoIdentifier: 'org/app', event: { targetBranch: 'main' }, global: g };
    expect(globalJobConfigFields(ctx, 'https://example/org/ci.git')).toEqual({
      isGlobalWorkflow: true,
      workflowRepoUrl: 'https://example/org/ci.git',
      workflowRef: 'main',
      workflowSha: 'a1',
      workflowRepoIdentifier: 'org/ci',
      workflowRoutingKey: 'rk',
      workflowProviderContext: {},
    });
  });
});

describe('policyRoutingKey', () => {
  it('a global run reads the workflow repository source; a same-repo run its own', () => {
    // fails-when: a global run returns the event's routing key (B's overrides layer over A's context)
    // breaks-if-wrong: a same-repo run must keep its own routing key
    const info = { routingKey: 'rk-app' };
    expect(policyRoutingKey({ info, global: g })).toBe('rk');
    expect(policyRoutingKey({ info })).toBe('rk-app');
  });
});

describe('globalJobConfigFor', () => {
  const ctx = { repoIdentifier: 'org/app', event: { targetBranch: 'main' } };
  const urlBundle = {
    repoUrlBuilder: { buildCloneUrl: (r: string) => `https://git.example/${r}.git` },
  } as unknown as GlobalDispatchIdentity['workflowBundle'];

  it('builds the workflow clone URL from the workflow bundle', () => {
    // breaks-if-wrong: a bundle that builds a URL must pass it through
    expect(
      globalJobConfigFor({ ...ctx, global: { ...g, workflowBundle: urlBundle } }),
    ).toMatchObject({ isGlobalWorkflow: true, workflowRepoUrl: 'https://git.example/org/ci.git' });
  });

  it('is empty for a same-repo run', () => {
    expect(globalJobConfigFor(ctx)).toEqual({});
  });

  it('throws when the workflow bundle cannot build a clone URL', () => {
    // fails-when: an empty workflowRepoUrl is emitted alongside isGlobalWorkflow
    expect(() => globalJobConfigFor({ ...ctx, global: g })).toThrow(/cannot build a clone URL/);
  });
});
