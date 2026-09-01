import { describe, it, expect, vi } from 'vitest';
import { resolveContainerSpawn, resolveContainerRegistryAuth } from './resolve-container-auth.js';

describe('resolveContainerSpawn', () => {
  it('resolves usernameSecret + tokenSecret into an authconfig', async () => {
    const resolveSecret = vi.fn(async (r: string) =>
      r === 'prod:u' ? 'bot' : r === 'prod:t' ? 's3cr3t' : undefined,
    );
    expect(
      await resolveContainerSpawn(
        {
          image: 'reg:5000/acme/ci:1.2',
          auth: { usernameSecret: 'prod:u', tokenSecret: 'prod:t' },
        },
        { resolveSecret },
      ),
    ).toEqual({
      image: 'reg:5000/acme/ci:1.2',
      authconfig: { username: 'bot', password: 's3cr3t', serveraddress: 'reg:5000' },
    });
  });

  it('uses a plain username without resolving it', async () => {
    const resolveSecret = vi.fn(async () => 'tok');
    const out = await resolveContainerSpawn(
      { image: 'ghcr.io/x/y', auth: { username: 'x-token', tokenSecret: 'prod:t' } },
      { resolveSecret },
    );
    expect(out?.authconfig?.username).toBe('x-token');
    expect(resolveSecret).toHaveBeenCalledTimes(1);
  });

  it('takes the *Value half verbatim without resolving it', async () => {
    // A token fetched at run time has no secret-store entry to name, so the
    // `*Value` half of the Sourced pair carries the material itself.
    const resolveSecret = vi.fn(async () => undefined);
    const out = await resolveContainerSpawn(
      { image: 'ghcr.io/x/y', auth: { username: 'bot', tokenValue: 'runtime-token' } },
      { resolveSecret },
    );
    expect(out?.authconfig?.password).toBe('runtime-token');
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it('refuses both halves of one pair being set', async () => {
    await expect(
      resolveContainerSpawn(
        { image: 'x', auth: { tokenSecret: 'prod:t', tokenValue: 'inline' } },
        { resolveSecret: async () => 'v' },
      ),
    ).rejects.toThrow(/exactly one of tokenSecret or tokenValue/i);
  });

  it('carries a bare image string through with no authconfig', async () => {
    expect(
      await resolveContainerSpawn('python:3.12-slim', { resolveSecret: async () => undefined }),
    ).toEqual({ image: 'python:3.12-slim' });
  });

  it('returns image with no authconfig when there is no auth', async () => {
    expect(
      await resolveContainerSpawn(
        { image: 'python:3.12-slim' },
        { resolveSecret: async () => undefined },
      ),
    ).toEqual({ image: 'python:3.12-slim' });
  });

  it('carries env alongside the image', async () => {
    const out = await resolveContainerSpawn(
      { image: 'python:3.12-slim', env: { CI: '1' } },
      { resolveSecret: async () => undefined },
    );
    expect(out).toEqual({ image: 'python:3.12-slim', env: { CI: '1' } });
  });

  it('returns undefined when there is no container at all', async () => {
    expect(
      await resolveContainerSpawn(undefined, { resolveSecret: async () => undefined }),
    ).toBeUndefined();
  });

  it('throws naming the missing key (never the value)', async () => {
    await expect(
      resolveContainerSpawn(
        { image: 'x', auth: { tokenSecret: 'prod:missing' } },
        { resolveSecret: async () => undefined },
      ),
    ).rejects.toThrow(/container registry secret 'prod:missing' not found/i);
  });

  it('rejects an unqualified secret reference', async () => {
    await expect(
      resolveContainerSpawn(
        { image: 'x', auth: { tokenSecret: 'no-context' } },
        { resolveSecret: async () => 'v' },
      ),
    ).rejects.toThrow(/qualified <context>:<secret-name>/i);
  });

  it('requires a token when auth is present', async () => {
    await expect(
      resolveContainerSpawn(
        { image: 'x', auth: { username: 'bot' } as never },
        { resolveSecret: async () => 'v' },
      ),
    ).rejects.toThrow(/missing 'tokenSecret'/i);
  });

  it('never puts the resolved token in the error when the username lookup fails', async () => {
    const resolveSecret = vi.fn(async (r: string) => (r === 'prod:t' ? 'super-secret' : undefined));
    await expect(
      resolveContainerSpawn(
        { image: 'x', auth: { usernameSecret: 'prod:missing-u', tokenSecret: 'prod:t' } },
        { resolveSecret },
      ),
    ).rejects.toThrow(/^(?!.*super-secret).*$/s);
  });
});

describe('resolveContainerSpawn with a dockerfile container', () => {
  it('stands down, because there is no image to spawn an agent from', async () => {
    // The image does not exist when the spawn decision is made — an agent has
    // to clone and build it first. Returning a spawn here would boot an agent
    // from an image nothing has produced.
    expect(
      await resolveContainerSpawn(
        { dockerfile: '.kici/ci.Dockerfile' },
        { resolveSecret: async () => undefined },
      ),
    ).toBeUndefined();
  });

  it('stands down even when the job declared registry credentials', async () => {
    expect(
      await resolveContainerSpawn(
        { dockerfile: 'Dockerfile', auth: { registry: 'reg:5000', tokenValue: 't' } },
        { resolveSecret: async () => undefined },
      ),
    ).toBeUndefined();
  });
});

describe('resolveContainerRegistryAuth', () => {
  it('derives the registry host from the image reference', async () => {
    expect(
      await resolveContainerRegistryAuth(
        { image: 'reg.internal:5000/a/b:1', auth: { tokenValue: 's3cr3t' } },
        { resolveSecret: async () => undefined },
      ),
    ).toEqual({
      username: 'x-access-token',
      password: 's3cr3t',
      serveraddress: 'reg.internal:5000',
    });
  });

  it('takes the registry host from auth.registry for a dockerfile build', async () => {
    // There is no image reference to derive it from: the base is named inside
    // the Dockerfile.
    expect(
      await resolveContainerRegistryAuth(
        {
          dockerfile: 'Dockerfile',
          auth: { registry: 'reg.internal:5000', tokenValue: 's3cr3t' },
        },
        { resolveSecret: async () => undefined },
      ),
    ).toEqual({
      username: 'x-access-token',
      password: 's3cr3t',
      serveraddress: 'reg.internal:5000',
    });
  });

  it('refuses a dockerfile build whose credentials name no registry', async () => {
    await expect(
      resolveContainerRegistryAuth(
        { dockerfile: 'Dockerfile', auth: { tokenValue: 's3cr3t' } },
        { resolveSecret: async () => undefined },
      ),
    ).rejects.toThrow(/auth.registry is required/);
  });

  it('returns undefined when the job declared no credentials', async () => {
    expect(
      await resolveContainerRegistryAuth(
        { dockerfile: 'Dockerfile' },
        { resolveSecret: async () => undefined },
      ),
    ).toBeUndefined();
    expect(
      await resolveContainerRegistryAuth('python:3.12', {
        resolveSecret: async () => undefined,
      }),
    ).toBeUndefined();
  });
});
