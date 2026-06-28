import { describe, expect, it, vi } from 'vitest';
import { createProvenanceTrustRoot, deriveJwksUri } from './trust-root.js';

describe('deriveJwksUri', () => {
  it('appends well-known path, trimming trailing slashes', () => {
    expect(deriveJwksUri('https://i.example/')).toBe('https://i.example/.well-known/jwks.json');
    expect(deriveJwksUri('https://i.example')).toBe('https://i.example/.well-known/jwks.json');
  });
});

describe('ProvenanceTrustRoot', () => {
  const jwks = { keys: [{ kid: 'k1', kty: 'EC' }] };
  const jwks2 = {
    keys: [
      { kid: 'k1', kty: 'EC' },
      { kid: 'k2', kty: 'EC' },
    ],
  };

  it('returns null jwks when no issuer set', async () => {
    const tr = createProvenanceTrustRoot();
    expect(await tr.getJwks()).toBeNull();
    expect(tr.getIssuer()).toBeNull();
  });

  it('accepts an issuer from construction (CLI path)', () => {
    expect(createProvenanceTrustRoot({ issuer: 'https://i.example' }).getIssuer()).toBe(
      'https://i.example',
    );
  });

  it('fetches + caches the jwks for a set issuer', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }));
    const tr = createProvenanceTrustRoot({ fetchImpl: fetchImpl as unknown as typeof fetch });
    tr.setIssuer('https://i.example');
    expect(await tr.getJwks()).toEqual(jwks);
    await tr.getJwks();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // cached
  });

  it('refetches once when a requested kid is missing from the cached set', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(jwks), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(jwks2), { status: 200 }));
    const tr = createProvenanceTrustRoot({ fetchImpl: fetchImpl as unknown as typeof fetch });
    tr.setIssuer('https://i.example');
    await tr.getJwks(); // caches jwks (k1 only)
    const got = await tr.getJwks('k2'); // k2 absent -> refetch -> jwks2
    expect(got).toEqual(jwks2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns null when the jwks fetch fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const tr = createProvenanceTrustRoot({ fetchImpl: fetchImpl as unknown as typeof fetch });
    tr.setIssuer('https://i.example');
    expect(await tr.getJwks()).toBeNull();
  });

  it('clears the cache when the issuer changes', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }));
    const tr = createProvenanceTrustRoot({ fetchImpl: fetchImpl as unknown as typeof fetch });
    tr.setIssuer('https://a.example');
    await tr.getJwks();
    tr.setIssuer('https://b.example');
    await tr.getJwks();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
