import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InsecureTrustRootError,
  resolveTrustRoot,
  trustRootTransportVerdict,
} from './provenance-trust-root.js';

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

describe('trustRootTransportVerdict', () => {
  // fails-when: the classifier uses startsWith('http://localhost') —
  // localhost.evil.com would read as loopback.
  it.each([
    ['https://a', 'https'],
    ['http://localhost:4319', 'loopback-http'],
    ['http://127.9.9.9', 'loopback-http'],
    ['http://[::1]:1', 'loopback-http'],
    ['http://192.0.2.10:10143', 'insecure-http'],
    ['http://localhost.evil.com', 'insecure-http'],
    ['http://127.0.0.1.nip.io', 'insecure-http'],
  ] as const)('%s → %s', (url, verdict) => {
    expect(trustRootTransportVerdict(url)).toBe(verdict);
  });
});

describe('resolveTrustRoot transport checks', () => {
  afterEach(() => vi.restoreAllMocks());

  const json = (body: unknown, url = '') => {
    const res = new Response(JSON.stringify(body), { status: 200 });
    if (url) Object.defineProperty(res, 'url', { value: url });
    return res;
  };

  // fails-when: the guard is missing — the stub is called and the promise resolves.
  it('refuses a plain-HTTP base on a host that is not loopback before any fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const err = await resolveTrustRoot('http://10.0.0.5:10143').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsecureTrustRootError);
    expect((err as Error).message).toContain(
      'http://10.0.0.5:10143/.well-known/openid-configuration',
    );
    expect((err as Error).message).toContain('--allow-insecure-trust-root');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // fails-when: only the base URL is checked.
  it('refuses a plain-HTTP jwks_uri without fetching it', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ issuer: 'https://i', jwks_uri: 'http://10.0.0.5/jwks' }));
    await expect(resolveTrustRoot('https://i')).rejects.toBeInstanceOf(InsecureTrustRootError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // fails-when: the check reads the request URL instead of res.url.
  it('refuses an https discovery redirected to plain HTTP', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json({ issuer: 'https://i' }, 'http://10.0.0.5/.well-known/openid-configuration'),
    );
    await expect(resolveTrustRoot('https://i')).rejects.toBeInstanceOf(InsecureTrustRootError);
  });

  const redirect = (location: string) => new Response(null, { status: 301, headers: { location } });

  // fails-when: only the request and final URLs are checked — a plain-HTTP hop
  // in the middle of a chain that ends on https passes unseen.
  it('refuses an https chain that passes through a plain-HTTP hop', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirect('http://10.0.0.5/hop'))
      .mockResolvedValueOnce(redirect('https://attacker.example/disco'))
      .mockResolvedValueOnce(json({ issuer: 'https://i' }));
    const err = await resolveTrustRoot('https://i').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsecureTrustRootError);
    expect((err as Error).message).toContain('http://10.0.0.5/hop');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // breaks-if-wrong: an https-only redirect (a canonical-host move) still resolves.
  it('follows an https-only redirect chain', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirect('/moved/.well-known/openid-configuration'))
      .mockResolvedValueOnce(json({ issuer: 'https://i', jwks_uri: 'https://i/jwks' }))
      .mockResolvedValueOnce(json({ keys: [{ kid: 'k' }] }));
    const r = await resolveTrustRoot('https://i');
    expect(r.jwks.keys[0]).toMatchObject({ kid: 'k' });
    expect(r.warnings).toEqual([]);
  });

  it('stops after too many redirects', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(redirect('https://i/loop')),
    );
    await expect(resolveTrustRoot('https://i')).rejects.toThrow(/more than 5 redirects/);
  });

  // breaks-if-wrong: the opt-in path must still verify.
  it('accepts each refused case with allowInsecure and warns once per URL', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ issuer: 'http://10.0.0.5', jwks_uri: 'http://10.0.0.5/jwks' }))
      .mockResolvedValueOnce(json({ keys: [{ kid: 'k' }] }));
    const base = await resolveTrustRoot('http://10.0.0.5', { allowInsecure: true });
    expect(base.jwks.keys[0]).toMatchObject({ kid: 'k' });
    expect(base.warnings).toHaveLength(2);
    expect(base.warnings[0]).toContain('http://10.0.0.5/.well-known/openid-configuration');
    expect(base.warnings[1]).toContain('http://10.0.0.5/jwks');

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ issuer: 'https://i', jwks_uri: 'http://10.0.0.5/jwks' }))
      .mockResolvedValueOnce(json({ keys: [] }));
    const jwksUri = await resolveTrustRoot('https://i', { allowInsecure: true });
    expect(jwksUri.warnings).toEqual([expect.stringContaining('http://10.0.0.5/jwks')]);

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ issuer: 'https://i' }, 'http://10.0.0.5/disco'))
      .mockResolvedValueOnce(json({ keys: [] }));
    const redirect = await resolveTrustRoot('https://i', { allowInsecure: true });
    expect(redirect.issuer).toBe('https://i');
    expect(redirect.warnings).toEqual([expect.stringContaining('http://10.0.0.5/disco')]);
  });

  // breaks-if-wrong: a local orchestrator is commonly reached at http://localhost.
  it.each(['http://localhost:4319', 'http://127.0.0.1:4319'])(
    'allows loopback %s silently',
    async (base) => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(json({ issuer: base, jwks_uri: `${base}/jwks` }))
        .mockResolvedValueOnce(json({ keys: [] }));
      const r = await resolveTrustRoot(base);
      expect(r.issuer).toBe(base);
      expect(r.warnings).toEqual([]);
    },
  );

  // breaks-if-wrong: the common customer path must not change.
  it('leaves an https base with an https jwks_uri unaffected', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        json(
          { issuer: 'https://i', jwks_uri: 'https://i/jwks' },
          'https://i/.well-known/openid-configuration',
        ),
      )
      .mockResolvedValueOnce(json({ keys: [] }, 'https://i/jwks'));
    expect((await resolveTrustRoot('https://i')).warnings).toEqual([]);
  });
});
