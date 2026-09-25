import { describe, it, expect, vi } from 'vitest';
import { DecoratingSecretResolver } from './decorating-secret-resolver.js';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';

/** A minimal base resolver whose resolveForContext returns the given env map. */
function baseResolver(env: Record<string, string>): SecretResolverApi {
  return {
    resolveForContext: vi.fn().mockResolvedValue(env),
    resolveNamedInternal: vi.fn().mockResolvedValue('named'),
    resolveForContextWithMeta: vi.fn().mockResolvedValue({}),
  } as unknown as SecretResolverApi;
}

describe('DecoratingSecretResolver', () => {
  it('overlays CLI flat secrets on top of env secrets (CLI wins)', async () => {
    const base = baseResolver({ A: 'env', B: 'env' });
    const r = new DecoratingSecretResolver(base, { flat: { B: 'cli', C: 'cli' }, contexts: {} });
    expect(await r.resolveForContext('org', { id: 'ctx-prod', name: 'prod' })).toEqual({
      A: 'env',
      B: 'cli',
      C: 'cli',
    });
  });

  it('counts bindings through the base resolver, and offers no count when the base has none', async () => {
    const countContextBindings = vi.fn().mockResolvedValue(3);
    const counting = { ...baseResolver({}), countContextBindings } as SecretResolverApi;
    const r = new DecoratingSecretResolver(counting, { flat: {}, contexts: {} });
    // fails-when: the decorator drops the base's count, silencing the unbound-context warning
    expect(await r.countContextBindings?.('ctx-prod')).toBe(3);
    expect(countContextBindings).toHaveBeenCalledWith('ctx-prod');

    const plain = new DecoratingSecretResolver(baseResolver({}), { flat: {}, contexts: {} });
    expect(plain.countContextBindings).toBeUndefined();
  });

  it('is a pass-through to the base resolver when no CLI secrets are present', async () => {
    const base = baseResolver({ A: 'env' });
    const r = new DecoratingSecretResolver(base, { flat: {}, contexts: {} });
    expect(await r.resolveForContext('org', { id: 'ctx-prod', name: 'prod' })).toEqual({
      A: 'env',
    });
  });

  it('overlays a CLI context when the requested environment matches a context name', async () => {
    // The core resolves a declared context by calling resolveForContext(orgId, { id, name });
    // the decorator overlays the CLI context of the same name on top (CLI wins).
    const base = baseResolver({ DB_URL: 'env-db', SHARED: 'env' });
    const r = new DecoratingSecretResolver(base, {
      flat: {},
      contexts: { staging: { DB_URL: 'cli-db', EXTRA: 'cli-extra' } },
    });
    expect(await r.resolveForContext('org', { id: 'ctx-staging', name: 'staging' })).toEqual({
      DB_URL: 'cli-db',
      SHARED: 'env',
      EXTRA: 'cli-extra',
    });
  });

  it('applies BOTH the matching context and the CLI flat overlay (flat applied last)', async () => {
    const base = baseResolver({ A: 'env', B: 'env' });
    const r = new DecoratingSecretResolver(base, {
      flat: { B: 'cli-flat' },
      contexts: { prod: { A: 'cli-ctx' } },
    });
    // Context overlay first (A → cli-ctx), then flat overlay (B → cli-flat).
    expect(await r.resolveForContext('org', { id: 'ctx-prod', name: 'prod' })).toEqual({
      A: 'cli-ctx',
      B: 'cli-flat',
    });
  });

  it('keys the CLI context overlay by the declared name when a glob row matched', async () => {
    const base = baseResolver({ TOKEN: 'env' });
    const r = new DecoratingSecretResolver(base, {
      flat: {},
      contexts: { 'deploy-prod': { TOKEN: 'cli' } },
    });
    const context = { id: 'ctx-deploy-glob', name: 'deploy-prod' };
    expect(await r.resolveForContext('org', context)).toEqual({ TOKEN: 'cli' });
    // fails-when: the decorator swaps the matched row for a name-only lookup
    expect(base.resolveForContext).toHaveBeenCalledWith('org', context, undefined, undefined);
  });

  it('delegates resolveNamedInternal to the wrapped base resolver', async () => {
    const base = baseResolver({});
    const r = new DecoratingSecretResolver(base, { flat: {}, contexts: {} });
    expect(await r.resolveNamedInternal('org', 'scope', 'key')).toBe('named');
    expect(base.resolveNamedInternal).toHaveBeenCalledWith('org', 'scope', 'key', undefined);
  });

  it('forwards hostCtx to the base resolveForContext (per-host fan-out scoping, not fleet-wide)', async () => {
    const base = baseResolver({ A: 'env' });
    const r = new DecoratingSecretResolver(base, { flat: {}, contexts: {} });
    const hostCtx = { agentId: 'agent-01', host: 'runner-eu', labels: ['region=eu'] };
    await r.resolveForContext('org', { id: 'ctx-prod', name: 'prod' }, hostCtx);
    // The wrapped resolver must receive the host context — dropping it would
    // silently degrade per-host resolution to fleet-wide.
    expect(base.resolveForContext).toHaveBeenCalledWith(
      'org',
      { id: 'ctx-prod', name: 'prod' },
      hostCtx,
      undefined,
    );
  });

  it('forwards the audit attribution to the base resolveForContext', async () => {
    const base = baseResolver({ A: 'env' });
    const r = new DecoratingSecretResolver(base, { flat: {}, contexts: {} });
    const attribution = { runId: 'run-1', jobId: 'build' };
    await r.resolveForContext('org', { id: 'ctx-prod', name: 'prod' }, undefined, attribution);
    // fails-when: the decorator drops the attribution, so the audit entry names no job
    expect(base.resolveForContext).toHaveBeenCalledWith(
      'org',
      { id: 'ctx-prod', name: 'prod' },
      undefined,
      attribution,
    );
  });

  it('forwards hostCtx to the base resolveForContextWithMeta', async () => {
    const base = baseResolver({});
    const r = new DecoratingSecretResolver(base, { flat: {}, contexts: {} });
    const hostCtx = { agentId: 'agent-02', host: 'runner-us', labels: [] };
    await r.resolveForContextWithMeta('org', { id: 'ctx-staging', name: 'staging' }, hostCtx);
    expect(base.resolveForContextWithMeta).toHaveBeenCalledWith(
      'org',
      { id: 'ctx-staging', name: 'staging' },
      hostCtx,
    );
  });
});
