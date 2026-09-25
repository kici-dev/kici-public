import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcurrencyStrategy, ContextType, type Context } from '@kici-dev/engine';

const mockWarn = vi.fn();
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
  };
});

const { resolveContextJobData } = await import('./held-context-data.js');
const { UNBOUND_JOB_CONTEXT_MESSAGE } = await import('./unbound-job-context.js');
type ContextJobData = import('./held-context-data.js').ContextJobData;
type SecretResolverApi = import('../secrets/secret-resolver.js').SecretResolverApi;

function makeEnv(id: string, name: string): Context {
  return {
    id,
    orgId: 'org-1',
    name,
    type: ContextType.enum.fixed,
    globPattern: null,
    branchRestrictions: [],
    triggerTypeFilters: [],
    repoPatterns: [],
    concurrencyLimit: null,
    concurrencyStrategy: ConcurrencyStrategy.enum.queue,
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

const LOG = { runId: 'run-1', workflow: 'deploy', job: 'build' };

/**
 * A resolver whose contexts resolve `secretsById[id]` and carry
 * `bindingsById[id]` bindings. `countContextBindings` is left off when
 * `bindingsById` is omitted.
 */
function resolver(
  secretsById: Record<string, Record<string, string>>,
  bindingsById?: Record<string, number | Error>,
): SecretResolverApi {
  return {
    resolveForContext: vi.fn(
      async (_org: string, ctx: { id: string }) => secretsById[ctx.id] ?? {},
    ),
    resolveNamedInternal: vi.fn(),
    resolveForContextWithMeta: vi.fn(),
    ...(bindingsById && {
      countContextBindings: vi.fn(async (id: string) => {
        const count = bindingsById[id] ?? 0;
        if (count instanceof Error) throw count;
        return count;
      }),
    }),
  };
}

async function resolve(
  secretResolver: SecretResolverApi,
  entries: Array<{ name: string; env: Context }>,
): Promise<ContextJobData> {
  const into: ContextJobData = {};
  await resolveContextJobData({
    deps: { secretResolver },
    orgId: 'org-1',
    entries,
    log: LOG,
    into,
  });
  return into;
}

describe('resolveContextJobData unbound-context warning', () => {
  beforeEach(() => mockWarn.mockReset());

  it('warns once, naming org, context, run and job, for a context with no binding', async () => {
    const data = await resolve(
      resolver({ 'env-bound': { TOKEN: 't' } }, { 'env-bound': 1, 'env-unbound': 0 }),
      [
        { name: 'bound', env: makeEnv('env-bound', 'bound') },
        { name: 'unbound', env: makeEnv('env-unbound', 'unbound') },
      ],
    );

    // fails-when: a job context with zero bindings dispatches with no log line
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(UNBOUND_JOB_CONTEXT_MESSAGE, {
      orgId: 'org-1',
      context: 'unbound',
      contextId: 'env-unbound',
      runId: 'run-1',
      workflow: 'deploy',
      job: 'build',
    });
    // The warning changes nothing the job receives.
    expect(data.jobSecrets).toEqual({ TOKEN: 't' });
    expect(data.jobNamespacedSecrets).toEqual({ bound: { TOKEN: 't' } });
  });

  it('warns for every unbound context when none resolves a secret', async () => {
    await resolve(resolver({}, {}), [
      { name: 'a', env: makeEnv('env-a', 'a') },
      { name: 'b', env: makeEnv('env-b', 'b') },
    ]);

    expect(mockWarn.mock.calls.map((c) => (c[1] as { context: string }).context)).toEqual([
      'a',
      'b',
    ]);
  });

  it('stays silent for a bound context that resolves nothing on this host', async () => {
    // breaks-if-wrong: a host-gated binding resolves no secret yet the context is bound
    await resolve(resolver({}, { 'env-host': 2 }), [
      { name: 'host', env: makeEnv('env-host', 'host') },
    ]);

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns once for a context row two entries resolve to', async () => {
    await resolve(resolver({}, {}), [
      { name: 'x', env: makeEnv('env-x', 'x') },
      { name: 'x', env: makeEnv('env-x', 'x') },
    ]);

    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('skips the lookup for a resolver that cannot count bindings', async () => {
    const data = await resolve(resolver({}), [{ name: 'a', env: makeEnv('env-a', 'a') }]);

    expect(mockWarn).not.toHaveBeenCalled();
    expect(data).toEqual({});
  });

  it('logs nothing and still resolves when the binding count fails', async () => {
    const data = await resolve(
      resolver({ 'env-b': { K: 'v' } }, { 'env-a': new Error('db down'), 'env-b': 1 }),
      [
        { name: 'a', env: makeEnv('env-a', 'a') },
        { name: 'b', env: makeEnv('env-b', 'b') },
      ],
    );

    expect(mockWarn).not.toHaveBeenCalled();
    expect(data.jobSecrets).toEqual({ K: 'v' });
  });
});
