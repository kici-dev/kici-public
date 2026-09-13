import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTrustRoot } from './provenance-trust-root.js';

describe('resolveTrustRoot', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves an HTTPS issuer via discovery → jwks_uri', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ issuer: 'https://i', jwks_uri: 'https://i/.well-known/jwks.json' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [{ kid: 'k' }] }), { status: 200 }),
      );

    const { issuer, jwks } = await resolveTrustRoot('https://i');
    expect(issuer).toBe('https://i');
    expect(jwks.keys[0]).toMatchObject({ kid: 'k' });
    expect(fetchMock.mock.calls[0][0] as string).toContain('/.well-known/openid-configuration');
    expect(fetchMock.mock.calls[1][0] as string).toBe('https://i/.well-known/jwks.json');
  });

  it('strips a trailing slash from the issuer URL before discovery', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ issuer: 'https://i', jwks_uri: 'https://i/jwks' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [] }), { status: 200 }));

    await resolveTrustRoot('https://i/');
    expect(fetchMock.mock.calls[0][0] as string).toBe('https://i/.well-known/openid-configuration');
  });

  it('throws when discovery returns a non-2xx status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(resolveTrustRoot('https://i')).rejects.toThrow(/404/);
  });

  it('reads a self-contained offline trust-root file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-trust-'));
    try {
      const file = join(dir, 'trust-root.json');
      await writeFile(
        file,
        JSON.stringify({ issuer: 'https://offline', jwks: { keys: [{ kid: 'off' }] } }),
      );
      const { issuer, jwks } = await resolveTrustRoot(file);
      expect(issuer).toBe('https://offline');
      expect(jwks.keys[0]).toMatchObject({ kid: 'off' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when the offline file lacks issuer or jwks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kici-trust-'));
    try {
      const file = join(dir, 'bad.json');
      await writeFile(file, JSON.stringify({ issuer: 'https://offline' }));
      await expect(resolveTrustRoot(file)).rejects.toThrow(/issuer, jwks/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
