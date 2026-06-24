import { describe, it, expect, vi } from 'vitest';
import { DecoratingSecretResolver } from './decorating-secret-resolver.js';
import type { SecretResolverApi } from '../secrets/secret-resolver.js';

/** A minimal base resolver whose resolveForJob returns the given env map. */
function baseResolver(env: Record<string, string>): SecretResolverApi {
  return {
    resolveForJob: vi.fn().mockResolvedValue(env),
    resolveNamed: vi.fn().mockResolvedValue('named'),
    resolveForJobWithMeta: vi.fn().mockResolvedValue({}),
  } as unknown as SecretResolverApi;
}

describe('DecoratingSecretResolver', () => {
  it('overlays CLI flat secrets on top of env secrets (CLI wins)', async () => {
    const base = baseResolver({ A: 'env', B: 'env' });
    const r = new DecoratingSecretResolver(base, { flat: { B: 'cli', C: 'cli' }, contexts: {} });
    expect(await r.resolveForJob('org', 'prod')).toEqual({ A: 'env', B: 'cli', C: 'cli' });
  });

  it('is a pass-through to the base resolver when no CLI secrets are present', async () => {
    const base = baseResolver({ A: 'env' });
    const r = new DecoratingSecretResolver(base, { flat: {}, contexts: {} });
    expect(await r.resolveForJob('org', 'prod')).toEqual({ A: 'env' });
  });

  it('overlays a CLI context when the requested environment matches a context name', async () => {
    // The core resolves a declared context by calling resolveForJob(orgId, ctxName);
    // the decorator overlays the CLI context of the same name on top (CLI wins).
    const base = baseResolver({ DB_URL: 'env-db', SHARED: 'env' });
    const r = new DecoratingSecretResolver(base, {
      flat: {},
      contexts: { staging: { DB_URL: 'cli-db', EXTRA: 'cli-extra' } },
    });
    expect(await r.resolveForJob('org', 'staging')).toEqual({
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
    expect(await r.resolveForJob('org', 'prod')).toEqual({ A: 'cli-ctx', B: 'cli-flat' });
  });

  it('delegates resolveNamed to the wrapped base resolver', async () => {
    const base = baseResolver({});
    const r = new DecoratingSecretResolver(base, { flat: {}, contexts: {} });
    expect(await r.resolveNamed('org', 'scope', 'key')).toBe('named');
    expect(base.resolveNamed).toHaveBeenCalledWith('org', 'scope', 'key', undefined);
  });
});
