import { describe, expect, it, vi } from 'vitest';
import type { ContextStore } from '../contexts/context-store.js';
import type { JobDispatchContext } from '../contexts/protection/pipeline.js';
import type { SecretResolverApi } from './secret-resolver.js';
import {
  assertResolvableJobScope,
  RESERVED_ORG_ID,
  resolveJobQualifiedSecret,
} from './job-secret-gate.js';

const ORG = 'org-acme';

function dispatchCtx(overrides: Partial<JobDispatchContext> = {}): JobDispatchContext {
  return {
    branch: 'main',
    triggerType: 'push',
    repository: 'acme/app',
    runId: 'run-1',
    jobId: 'build',
    ...overrides,
  };
}

/** A `contexts` row as the store returns it. Only the gate-relevant fields matter. */
function contextRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ctx-1',
    org_id: ORG,
    name: 'prod',
    type: 'fixed',
    glob_pattern: null,
    branch_restrictions: null,
    trigger_type_filters: null,
    repo_patterns: null,
    concurrency_limit: null,
    concurrency_strategy: 'queue',
    concurrency_timeout_ms: null,
    required_reviewers: null,
    wait_timer_seconds: null,
    hold_expiry_seconds: null,
    minimum_trust: null,
    allow_local_execution: false,
    enabled: true,
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function storeReturning(row: unknown): ContextStore {
  return { matchContext: vi.fn().mockResolvedValue(row) } as unknown as ContextStore;
}

function resolverReturning(value: string | null): SecretResolverApi {
  return {
    resolveForJob: vi.fn(),
    resolveForJobWithMeta: vi.fn(),
    resolveNamedInternal: vi.fn().mockResolvedValue(value),
  } as unknown as SecretResolverApi;
}

describe('assertResolvableJobScope', () => {
  it('refuses the reserved system organisation', () => {
    expect(() => assertResolvableJobScope(RESERVED_ORG_ID, 'prod')).toThrow(/reserved/);
  });

  it.each(['__source__/src-1', '__webhook__/wh-1', '__anything__'])(
    'refuses the reserved scope %s',
    (scope) => {
      expect(() => assertResolvableJobScope(ORG, scope)).toThrow(/reserved/);
    },
  );

  it('names the namespace, never the secret', () => {
    expect(() => assertResolvableJobScope(ORG, '__source__/src-1')).toThrow(
      /__source__\/src-1.*belong to the orchestrator/s,
    );
  });

  it('admits an ordinary context name', () => {
    expect(() => assertResolvableJobScope(ORG, 'prod')).not.toThrow();
  });
});

describe('resolveJobQualifiedSecret', () => {
  it('resolves a context that is not bound to the job when its rules pass', async () => {
    const resolver = resolverReturning('s3cret');
    const value = await resolveJobQualifiedSecret({
      resolver,
      contextStore: storeReturning(contextRow()),
      orgId: ORG,
      runId: 'run-1',
      jobId: 'build',
      context: 'prod',
      key: 'DEPLOY_TOKEN',
      dispatchCtx: dispatchCtx(),
      trustTier: 'trusted',
    });
    expect(value).toBe('s3cret');
    expect(resolver.resolveNamedInternal).toHaveBeenCalledWith(ORG, 'prod', 'DEPLOY_TOKEN', {
      runId: 'run-1',
      jobId: 'build',
    });
  });

  it("refuses when the named context's branch restriction rejects, naming the rule", async () => {
    const resolver = resolverReturning('s3cret');
    await expect(
      resolveJobQualifiedSecret({
        resolver,
        contextStore: storeReturning(contextRow({ branch_restrictions: JSON.stringify(['main']) })),
        orgId: ORG,
        context: 'prod',
        key: 'DEPLOY_TOKEN',
        dispatchCtx: dispatchCtx({ branch: 'attacker/pr' }),
        trustTier: 'trusted',
      }),
    ).rejects.toThrow(/Context 'prod' does not admit this run \(reject\)/);
    expect(resolver.resolveNamedInternal).not.toHaveBeenCalled();
  });

  it('refuses a disabled context', async () => {
    const resolver = resolverReturning('s3cret');
    await expect(
      resolveJobQualifiedSecret({
        resolver,
        contextStore: storeReturning(contextRow({ enabled: false })),
        orgId: ORG,
        context: 'prod',
        key: 'DEPLOY_TOKEN',
        dispatchCtx: dispatchCtx(),
        trustTier: 'trusted',
      }),
    ).rejects.toThrow(/disabled/);
    expect(resolver.resolveNamedInternal).not.toHaveBeenCalled();
  });

  it('refuses the unknown contributor tier', async () => {
    const resolver = resolverReturning('s3cret');
    const contextStore = storeReturning(contextRow());
    await expect(
      resolveJobQualifiedSecret({
        resolver,
        contextStore,
        orgId: ORG,
        context: 'prod',
        key: 'DEPLOY_TOKEN',
        dispatchCtx: dispatchCtx(),
        trustTier: 'unknown',
      }),
    ).rejects.toThrow(/contributor tier/);
    // Refused before the store is even consulted.
    expect(contextStore.matchContext).not.toHaveBeenCalled();
    expect(resolver.resolveNamedInternal).not.toHaveBeenCalled();
  });

  it('admits an unresolved tier, matching the install-secrets reading of `undefined`', async () => {
    const value = await resolveJobQualifiedSecret({
      resolver: resolverReturning('s3cret'),
      contextStore: storeReturning(contextRow()),
      orgId: ORG,
      context: 'prod',
      key: 'DEPLOY_TOKEN',
      dispatchCtx: dispatchCtx(),
      trustTier: undefined,
    });
    expect(value).toBe('s3cret');
  });

  it('refuses a reserved namespace before touching the store', async () => {
    const resolver = resolverReturning('app-private-key');
    const contextStore = storeReturning(contextRow());
    await expect(
      resolveJobQualifiedSecret({
        resolver,
        contextStore,
        orgId: ORG,
        context: '__source__/src-1',
        key: 'privateKey',
        dispatchCtx: dispatchCtx(),
        trustTier: 'trusted',
      }),
    ).rejects.toThrow(/reserved/);
    expect(contextStore.matchContext).not.toHaveBeenCalled();
    expect(resolver.resolveNamedInternal).not.toHaveBeenCalled();
  });

  it('refuses a context that does not exist', async () => {
    await expect(
      resolveJobQualifiedSecret({
        resolver: resolverReturning('s3cret'),
        contextStore: storeReturning(null),
        orgId: ORG,
        context: 'ghost',
        key: 'K',
        dispatchCtx: dispatchCtx(),
        trustTier: 'trusted',
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('throws rather than returning null on a miss', async () => {
    await expect(
      resolveJobQualifiedSecret({
        resolver: resolverReturning(null),
        contextStore: storeReturning(contextRow()),
        orgId: ORG,
        context: 'prod',
        key: 'MISSING',
        dispatchCtx: dispatchCtx(),
        trustTier: 'trusted',
      }),
    ).rejects.toThrow(/Secret not found/);
  });
});
