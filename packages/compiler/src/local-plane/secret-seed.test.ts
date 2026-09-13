import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLocalSecretContexts, seedLocalSecrets, type SecretSeedClient } from './secret-seed.js';

describe('loadLocalSecretContexts', () => {
  let dir: string;
  let kiciDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kici-secret-seed-'));
    kiciDir = join(dir, '.kici');
    await mkdir(kiciDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('preserves secrets.yaml top-level contexts (does NOT flatten)', async () => {
    await writeFile(
      join(kiciDir, 'secrets.yaml'),
      'production:\n  DEPLOY_TOKEN: prod-token\nstaging:\n  DEPLOY_TOKEN: stg-token\n',
    );
    const contexts = await loadLocalSecretContexts(kiciDir);
    expect(contexts).toEqual({
      production: { DEPLOY_TOKEN: 'prod-token' },
      staging: { DEPLOY_TOKEN: 'stg-token' },
    });
  });

  it('reads .secrets INI sections and lets secrets.yaml win on key collision', async () => {
    await writeFile(
      join(kiciDir, '.secrets'),
      '[production]\nDEPLOY_TOKEN=ini-token\nEXTRA=ini-extra\n',
    );
    await writeFile(join(kiciDir, 'secrets.yaml'), 'production:\n  DEPLOY_TOKEN: yaml-token\n');
    const contexts = await loadLocalSecretContexts(kiciDir);
    expect(contexts.production).toEqual({ DEPLOY_TOKEN: 'yaml-token', EXTRA: 'ini-extra' });
  });

  it('returns {} when no secret files exist', async () => {
    expect(await loadLocalSecretContexts(kiciDir)).toEqual({});
  });
});

describe('seedLocalSecrets', () => {
  let dir: string;
  let kiciDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kici-secret-seed-'));
    kiciDir = join(dir, '.kici');
    await mkdir(kiciDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a context, binds scope=name, and sets each scoped secret', async () => {
    await writeFile(
      join(kiciDir, 'secrets.yaml'),
      'production:\n  DEPLOY_TOKEN: prod-token\n  API_KEY: prod-key\n',
    );
    const createContext = vi.fn().mockResolvedValue({ envId: 'env-1', created: true });
    const bindContext = vi.fn().mockResolvedValue({});
    const setSecret = vi.fn().mockResolvedValue(undefined);
    const client: SecretSeedClient = { createContext, bindContext, setSecret };

    const res = await seedLocalSecrets('http://127.0.0.1:4319', 'tok', {
      orgId: '__default__',
      kiciDir,
      client,
    });

    expect(res).toEqual({ contexts: ['production'], secretCount: 2 });
    expect(createContext).toHaveBeenCalledWith({
      orgId: '__default__',
      name: 'production',
      allowLocalExecution: true,
    });
    expect(bindContext).toHaveBeenCalledWith({
      orgId: '__default__',
      name: 'production',
      scopePattern: 'production',
      hostPattern: '**',
    });
    // Scope equals the context name; both keys land under it.
    expect(setSecret).toHaveBeenCalledWith(
      '__default__',
      'production',
      'DEPLOY_TOKEN',
      'prod-token',
    );
    expect(setSecret).toHaveBeenCalledWith('__default__', 'production', 'API_KEY', 'prod-key');
  });

  it('is a no-op (no admin calls) when there are no secret files', async () => {
    const createContext = vi.fn();
    const bindContext = vi.fn();
    const setSecret = vi.fn();
    const client: SecretSeedClient = { createContext, bindContext, setSecret };

    const res = await seedLocalSecrets('http://127.0.0.1:4319', 'tok', {
      orgId: '__default__',
      kiciDir,
      client,
    });

    expect(res).toEqual({ contexts: [], secretCount: 0 });
    expect(createContext).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
  });
});
