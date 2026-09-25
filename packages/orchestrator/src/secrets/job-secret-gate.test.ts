import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextType } from '@kici-dev/engine';

// Capture the module logger so the deprecated fallback's warning can be asserted.
const mockWarn = vi.hoisted(() => vi.fn());
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
  };
});

import type { ContextStore } from '../contexts/context-store.js';
import type { JobDispatchContext } from '../contexts/protection/pipeline.js';
import type { SecretResolverApi } from './secret-resolver.js';
import {
  assertResolvableJobScope,
  JobSecretRefusedError,
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
    type: ContextType.enum.fixed,
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

/**
 * A resolver whose matched context resolves `key` to `value` through its
 * bindings (nothing when `value` is null). The system-scoped direct lookup
 * answers too, so a test can prove when the gate does and does not fall back
 * to it.
 */
function resolverReturning(value: string | null, key = 'DEPLOY_TOKEN'): SecretResolverApi {
  return {
    resolveForContext: vi.fn().mockResolvedValue(value === null ? {} : { [key]: value }),
    resolveForContextWithMeta: vi.fn(),
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
    // The bindings of the row the gate evaluated, attributed to the job.
    expect(resolver.resolveForContext).toHaveBeenCalledWith(
      ORG,
      { id: 'ctx-1', name: 'prod' },
      undefined,
      { runId: 'run-1', jobId: 'build' },
    );
    expect(resolver.resolveNamedInternal).not.toHaveBeenCalled();
  });

  it("reads a glob-matched reference through the glob row's bindings", async () => {
    // 'deploy-prod' has no row of its own; the glob context 'deploy-*' matches it.
    const globRow = contextRow({
      id: 'ctx-glob',
      name: 'deploy-*',
      type: ContextType.enum.glob,
      glob_pattern: 'deploy-*',
    });
    const resolver = resolverReturning('glob-value');
    const value = await resolveJobQualifiedSecret({
      resolver,
      contextStore: storeReturning(globRow),
      orgId: ORG,
      context: 'deploy-prod',
      key: 'DEPLOY_TOKEN',
      dispatchCtx: dispatchCtx(),
      trustTier: 'trusted',
    });
    // fails-when: the value is read from a scope named 'deploy-prod' instead of the glob row
    expect(value).toBe('glob-value');
    expect(vi.mocked(resolver.resolveForContext).mock.calls[0][1]).toEqual({
      id: 'ctx-glob',
      name: 'deploy-prod',
    });
  });

  it('never reads the same-named scope when a bound scope carries the key', async () => {
    const resolver = resolverReturning('bound-value');
    vi.mocked(resolver.resolveNamedInternal).mockResolvedValue('same-named-scope-value');
    const value = await resolveJobQualifiedSecret({
      resolver,
      contextStore: storeReturning(contextRow()),
      orgId: ORG,
      context: 'prod',
      key: 'DEPLOY_TOKEN',
      dispatchCtx: dispatchCtx(),
      trustTier: 'trusted',
    });
    // fails-when: the same-named scope shadows the value bound to the context
    expect(value).toBe('bound-value');
    expect(resolver.resolveNamedInternal).not.toHaveBeenCalled();
  });

  describe('deprecated same-named scope for an exact context whose bindings lack the key', () => {
    beforeEach(() => mockWarn.mockClear());

    /** Resolve `prod:DEPLOY_TOKEN` against `row`; no scope bound to it carries the key. */
    function resolveUnbound(row: unknown, resolver: SecretResolverApi) {
      return resolveJobQualifiedSecret({
        resolver,
        contextStore: storeReturning(row),
        orgId: ORG,
        runId: 'run-1',
        jobId: 'build',
        context: 'prod',
        key: 'DEPLOY_TOKEN',
        dispatchCtx: dispatchCtx(),
        trustTier: 'trusted',
      });
    }

    it('reads the same-named scope and warns, naming org, context, run and job', async () => {
      const resolver = resolverReturning(null);
      vi.mocked(resolver.resolveNamedInternal).mockResolvedValue('legacy-value');
      // breaks-if-wrong: an exact-named context with no binding still resolves its same-named scope
      await expect(resolveUnbound(contextRow(), resolver)).resolves.toBe('legacy-value');
      expect(resolver.resolveNamedInternal).toHaveBeenCalledWith(ORG, 'prod', 'DEPLOY_TOKEN', {
        runId: 'run-1',
        jobId: 'build',
      });
      expect(mockWarn).toHaveBeenCalledTimes(1);
      const [message, fields] = mockWarn.mock.calls[0];
      expect(message).toMatch(/deprecated/i);
      expect(fields).toEqual({ orgId: ORG, context: 'prod', runId: 'run-1', jobId: 'build' });
      // fails-when: the warning carries the secret value
      expect(JSON.stringify(mockWarn.mock.calls)).not.toContain('legacy-value');
    });

    it('reads the same-named scope for a bound context whose bound scopes lack the key', async () => {
      // The context binds scopes that carry OTHER_KEY; DEPLOY_TOKEN sits only in the
      // scope named after the context.
      const resolver = resolverReturning('bound-value', 'OTHER_KEY');
      vi.mocked(resolver.resolveNamedInternal).mockResolvedValue('legacy-value');
      // fails-when: the fallback is limited to a context with no binding at all
      await expect(resolveUnbound(contextRow(), resolver)).resolves.toBe('legacy-value');
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0][0]).toMatch(/deprecated/i);
    });

    it('refuses when the same-named scope does not carry the key either', async () => {
      const resolver = resolverReturning(null);
      await expect(resolveUnbound(contextRow(), resolver)).rejects.toThrow(/Secret not found/);
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('never falls back for a glob-matched row', async () => {
      const globRow = contextRow({
        id: 'ctx-glob',
        name: 'pr*',
        type: ContextType.enum.glob,
        glob_pattern: 'pr*',
      });
      const resolver = resolverReturning(null);
      vi.mocked(resolver.resolveNamedInternal).mockResolvedValue('same-named-scope-value');
      // fails-when: a glob row reads the scope named after the declared name
      await expect(resolveUnbound(globRow, resolver)).rejects.toThrow(/Secret not found/);
      expect(resolver.resolveNamedInternal).not.toHaveBeenCalled();
    });

    it('never falls back for a glob row whose own name equals the reference', async () => {
      const globRow = contextRow({ type: ContextType.enum.glob, glob_pattern: 'pr*' });
      const resolver = resolverReturning(null);
      vi.mocked(resolver.resolveNamedInternal).mockResolvedValue('same-named-scope-value');
      await expect(resolveUnbound(globRow, resolver)).rejects.toThrow(/Secret not found/);
      expect(resolver.resolveNamedInternal).not.toHaveBeenCalled();
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
    expect(resolver.resolveForContext).not.toHaveBeenCalled();
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
    expect(resolver.resolveForContext).not.toHaveBeenCalled();
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
    expect(resolver.resolveForContext).not.toHaveBeenCalled();
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
    expect(resolver.resolveForContext).not.toHaveBeenCalled();
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

describe('resolveJobQualifiedSecret — contexts already admitted to the job', () => {
  const reviewerRow = contextRow({ required_reviewers: JSON.stringify(['alice']) });
  const args = (over: Record<string, unknown> = {}) => ({
    resolver: resolverReturning('s3cret', 'REGISTRY_TOKEN'),
    contextStore: storeReturning(reviewerRow),
    orgId: ORG,
    context: 'prod',
    key: 'REGISTRY_TOKEN',
    dispatchCtx: dispatchCtx(),
    trustTier: 'trusted' as const,
    ...over,
  });

  it('holds a reviewer-gated context that was not admitted, as a typed refusal', async () => {
    // breaks-if-wrong: without the admitted set the stateless reviewer gate still refuses
    await expect(resolveJobQualifiedSecret(args())).rejects.toBeInstanceOf(JobSecretRefusedError);
    await expect(resolveJobQualifiedSecret(args())).rejects.toThrow(/\(hold\)/);
  });

  it('resolves an admitted context without re-running its reviewer gate', async () => {
    // fails-when: the admitted set is ignored, so an approved job is held again
    await expect(
      resolveJobQualifiedSecret(args({ admittedContextIds: new Set(['ctx-1']) })),
    ).resolves.toBe('s3cret');
  });

  it('gates a context recreated under the same name, whose id was never admitted', async () => {
    // fails-when: admission is matched by name, so a recreated context inherits the approval
    await expect(
      resolveJobQualifiedSecret(args({ admittedContextIds: new Set(['ctx-old']) })),
    ).rejects.toThrow(/does not admit this run/);
  });

  it('still refuses an untrusted tier for an admitted context', async () => {
    // breaks-if-wrong: admission skips the protection rules only, never the tier refusal
    await expect(
      resolveJobQualifiedSecret(
        args({ admittedContextIds: new Set(['ctx-1']), trustTier: 'unknown' }),
      ),
    ).rejects.toThrow(/contributor tier/);
  });

  it('lets a store failure propagate untyped', async () => {
    const contextStore = {
      matchContext: vi.fn().mockRejectedValue(new Error('db down')),
    } as unknown as ContextStore;
    const err = await resolveJobQualifiedSecret(args({ contextStore })).catch((e: unknown) => e);
    // fails-when: a store failure is wrapped as a refusal, so release omits auth instead of failing
    expect(err).not.toBeInstanceOf(JobSecretRefusedError);
    expect((err as Error).message).toBe('db down');
  });
});
